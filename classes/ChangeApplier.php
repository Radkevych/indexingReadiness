<?php

/**
 * @file plugins/generic/indexingReadiness/classes/ChangeApplier.php
 *
 * Distributed under the GNU GPL v3.
 *
 * @class ChangeApplier
 *
 * @brief Writes confirmed metadata additions into the current (published)
 *  publication of a submission and rolls them back.
 *
 *  Safety rules:
 *   - only EMPTY fields are filled; a non-empty value is never overwritten;
 *   - each operation is re-validated on the server against the current data;
 *   - previous values are stored in ChangeLog for rollback;
 *   - after a change, the submission's DOIs are marked stale and, on request,
 *     queued for deposit with the configured registration agency.
 */

namespace APP\plugins\generic\indexingReadiness\classes;

use APP\core\Application;
use APP\facades\Repo;
use APP\plugins\IDoiRegistrationAgency;
use APP\submission\Submission;
use PKP\context\Context;
use PKP\core\Core;
use PKP\doi\Doi;
use PKP\jobs\doi\DepositSubmission;
use PKP\user\User;

class ChangeApplier
{
    public const MAX_TITLE = 1000;
    public const MAX_ABSTRACT = 30000;
    public const MAX_KEYWORDS = 40;
    public const MAX_KEYWORD = 200;
    public const MAX_REFERENCES = 400;
    public const MAX_REFERENCE = 2000;

    public function __construct(
        protected Context $context,
        protected ChangeLog $log,
        protected ?User $user
    ) {
    }

    /**
     * Apply operations to the current publication of a submission.
     *
     * @param array $ops List of operations (see js/report.js, buildOps())
     */
    public function apply(int $submissionId, array $ops, bool $deposit, string $source = ''): array
    {
        $submission = $this->getSubmission($submissionId);
        $publication = $submission->getCurrentPublication();
        $locales = $this->context->getSupportedSubmissionMetadataLocales();

        $applied = [];
        $skipped = [];
        $pubParams = [];
        $authorParams = [];   // authorId => params
        $rorChanges = [];     // [affiliation, ror]
        $newAffiliations = []; // authorId => [locale => name]

        $authors = [];
        foreach ($publication->getData('authors') ?? [] as $author) {
            $authors[(int) $author->getId()] = $author;
        }

        foreach ($ops as $index => $op) {
            $type = (string) ($op['type'] ?? '');
            $label = (string) ($op['label'] ?? $type);
            try {
                switch ($type) {
                    case 'title':
                    case 'abstract':
                        $locale = $this->requireLocale($op, $locales);
                        $current = $pubParams[$type] ?? (array) ($publication->getData($type) ?? []);
                        if ($this->hasText($current[$locale] ?? null)) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.filled'));
                        }
                        $value = $type === 'abstract'
                            ? $this->cleanMultiline((string) ($op['value'] ?? ''), self::MAX_ABSTRACT)
                            : $this->cleanText((string) ($op['value'] ?? ''), self::MAX_TITLE);
                        if ($value === '') {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.empty'));
                        }
                        $current[$locale] = $type === 'abstract'
                            ? $this->toParagraphs($value)
                            : htmlspecialchars($value, ENT_NOQUOTES, 'UTF-8');
                        $pubParams[$type] = $current;
                        $applied[] = ['index' => $index, 'type' => $type, 'locale' => $locale, 'before' => null, 'after' => $current[$locale], 'label' => $label];
                        break;

                    case 'keywords':
                        $locale = $this->requireLocale($op, $locales);
                        $current = $pubParams['keywords'] ?? (array) ($publication->getData('keywords') ?? []);
                        if (!empty(array_filter((array) ($current[$locale] ?? []), fn ($k) => $this->hasText(is_array($k) ? ($k['name'] ?? '') : $k)))) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.filled'));
                        }
                        $values = [];
                        foreach ((array) ($op['values'] ?? []) as $keyword) {
                            $keyword = $this->cleanText((string) $keyword, self::MAX_KEYWORD);
                            if ($keyword !== '' && !in_array($keyword, $values, true)) {
                                $values[] = $keyword;
                            }
                        }
                        if (!$values) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.empty'));
                        }
                        $values = array_slice($values, 0, self::MAX_KEYWORDS);
                        $current[$locale] = $values;
                        $pubParams['keywords'] = $current;
                        $applied[] = ['index' => $index, 'type' => $type, 'locale' => $locale, 'before' => null, 'after' => $values, 'label' => $label];
                        break;

                    case 'citationsRaw':
                        if ($this->hasText((string) $publication->getData('citationsRaw'))) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.filled'));
                        }
                        $lines = [];
                        foreach (preg_split('/\R/u', (string) ($op['value'] ?? '')) as $line) {
                            $line = $this->cleanText($line, self::MAX_REFERENCE);
                            if ($line !== '') {
                                $lines[] = $line;
                            }
                        }
                        if (!$lines) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.empty'));
                        }
                        $value = implode("\n", array_slice($lines, 0, self::MAX_REFERENCES));
                        $pubParams['citationsRaw'] = $value;
                        $applied[] = ['index' => $index, 'type' => $type, 'before' => null, 'after' => $value, 'label' => $label];
                        break;

                    case 'licenseUrl':
                        if ($this->hasText((string) $publication->getData('licenseUrl'))) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.filled'));
                        }
                        $value = trim((string) ($op['value'] ?? ''));
                        if (!preg_match('~^https?://\S+$~i', $value)) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.invalid'));
                        }
                        $pubParams['licenseUrl'] = $value;
                        $applied[] = ['index' => $index, 'type' => $type, 'before' => null, 'after' => $value, 'label' => $label];
                        break;

                    case 'pages':
                        if ($this->hasText((string) $publication->getData('pages'))) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.filled'));
                        }
                        $value = preg_replace('/\s*[-–—]\s*/u', '-', trim((string) ($op['value'] ?? ''))) ?? '';
                        if (!preg_match('/^\d{1,5}(-\d{1,5})?$/', $value)) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.invalid'));
                        }
                        $pubParams['pages'] = $value;
                        $applied[] = ['index' => $index, 'type' => $type, 'before' => null, 'after' => $value, 'label' => $label];
                        break;

                    case 'authorEmail':
                        $author = $this->requireAuthor($op, $authors);
                        $authorId = (int) $author->getId();
                        if ($this->hasText($authorParams[$authorId]['email'] ?? $author->getData('email'))) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.filled'));
                        }
                        $email = trim((string) ($op['email'] ?? ''));
                        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.invalid'));
                        }
                        $authorParams[$authorId]['email'] = $email;
                        $applied[] = ['index' => $index, 'type' => $type, 'authorId' => $authorId, 'before' => null, 'after' => $email, 'label' => $label];
                        break;

                    case 'authorAffiliation':
                        $author = $this->requireAuthor($op, $authors);
                        $authorId = (int) $author->getId();
                        if (count($author->getAffiliations()) || isset($newAffiliations[$authorId])) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.filled'));
                        }
                        $names = [];
                        foreach ((array) ($op['names'] ?? []) as $locale => $name) {
                            if (!in_array($locale, $locales, true)) {
                                continue;
                            }
                            $name = $this->cleanText((string) $name, 500);
                            if ($name !== '') {
                                $names[$locale] = $name;
                            }
                        }
                        if (!$names) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.empty'));
                        }
                        $newAffiliations[$authorId] = $names;
                        $applied[] = ['index' => $index, 'type' => $type, 'authorId' => $authorId, 'before' => null, 'after' => $names, 'label' => $label];
                        break;

                    case 'authorName':
                        $locale = $this->requireLocale($op, $locales);
                        $author = $this->requireAuthor($op, $authors);
                        $authorId = (int) $author->getId();
                        $given = $authorParams[$authorId]['givenName'] ?? (array) ($author->getData('givenName') ?? []);
                        $family = $authorParams[$authorId]['familyName'] ?? (array) ($author->getData('familyName') ?? []);
                        if ($this->hasText($given[$locale] ?? null) || $this->hasText($family[$locale] ?? null)) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.filled'));
                        }
                        $newGiven = $this->cleanText((string) ($op['givenName'] ?? ''), 255);
                        $newFamily = $this->cleanText((string) ($op['familyName'] ?? ''), 255);
                        if ($newGiven === '' && $newFamily === '') {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.empty'));
                        }
                        $given[$locale] = $newGiven;
                        $family[$locale] = $newFamily;
                        $authorParams[$authorId]['givenName'] = $given;
                        $authorParams[$authorId]['familyName'] = $family;
                        $applied[] = ['index' => $index, 'type' => $type, 'authorId' => $authorId, 'locale' => $locale, 'before' => null,
                            'after' => ['givenName' => $newGiven, 'familyName' => $newFamily], 'label' => $label];
                        break;

                    case 'authorOrcid':
                        $author = $this->requireAuthor($op, $authors);
                        $authorId = (int) $author->getId();
                        if ($this->hasText($authorParams[$authorId]['orcid'] ?? $author->getData('orcid'))) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.filled'));
                        }
                        $orcid = $this->normalizeOrcid((string) ($op['orcid'] ?? ''));
                        if (!$orcid) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.invalid'));
                        }
                        $authorParams[$authorId]['orcid'] = $orcid;
                        $applied[] = ['index' => $index, 'type' => $type, 'authorId' => $authorId, 'before' => null, 'after' => $orcid, 'label' => $label];
                        break;

                    case 'affiliationRor':
                        $author = $this->requireAuthor($op, $authors);
                        $affiliation = null;
                        foreach ($author->getAffiliations() as $candidate) {
                            if ((int) $candidate->getId() === (int) ($op['affiliationId'] ?? 0)) {
                                $affiliation = $candidate;
                            }
                        }
                        if (!$affiliation) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.notFound'));
                        }
                        if ($this->hasText($affiliation->getRor())) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.filled'));
                        }
                        $ror = strtolower(trim((string) ($op['ror'] ?? '')));
                        if (!preg_match('~^https://ror\.org/0[a-z0-9]{6}[0-9]{2}$~', $ror)) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.invalid'));
                        }
                        // OJS 3.5 shows the organisation name from its local ROR registry and
                        // drops the manually entered name the next time the author is saved,
                        // so a ROR ID is written only if it exists in the local registry.
                        if (!Repo::ror()->getCollector()->filterByRor($ror)->getCount()) {
                            throw new SkipException(__('plugins.generic.indexingReadiness.skip.rorNotLocal'));
                        }
                        $rorChanges[] = [$affiliation, $ror];
                        $applied[] = ['index' => $index, 'type' => $type, 'authorId' => (int) $author->getId(),
                            'affiliationId' => (int) $affiliation->getId(), 'before' => null, 'after' => $ror, 'label' => $label];
                        break;

                    default:
                        throw new SkipException(__('plugins.generic.indexingReadiness.skip.unknown'));
                }
            } catch (SkipException $e) {
                $skipped[] = ['index' => $index, 'type' => $type, 'label' => $label, 'reason' => $e->getMessage()];
            }
        }

        if (!$applied) {
            return ['applied' => [], 'skipped' => $skipped, 'entryId' => null, 'deposit' => null];
        }

        // Write
        if ($pubParams) {
            Repo::publication()->edit($publication, $pubParams);
        }
        foreach ($authorParams as $authorId => $params) {
            Repo::author()->edit($authors[$authorId], $params);
        }
        foreach ($rorChanges as [$affiliation, $ror]) {
            // Manually entered names are kept as a fallback for the ROR record.
            Repo::affiliation()->edit($affiliation, ['ror' => $ror]);
        }
        foreach ($newAffiliations as $authorId => $names) {
            $affiliation = Repo::affiliation()->newDataObject(['authorId' => $authorId, 'name' => $names]);
            $affiliationId = Repo::affiliation()->add($affiliation);
            foreach ($applied as &$change) {
                if ($change['type'] === 'authorAffiliation' && $change['authorId'] === $authorId) {
                    $change['affiliationId'] = (int) $affiliationId;
                }
            }
            unset($change);
        }

        $this->afterChange($submission);
        $depositStatus = $deposit ? $this->deposit($submission) : null;

        $entryId = $this->log->add([
            'date' => Core::getCurrentDate(),
            'userId' => $this->user?->getId(),
            'userName' => $this->user ? $this->user->getFullName() : '',
            'submissionId' => $submissionId,
            'publicationId' => (int) $publication->getId(),
            'title' => (string) $publication->getLocalizedFullTitle(null),
            'source' => $source,
            'changes' => $applied,
        ]);

        return ['applied' => $applied, 'skipped' => $skipped, 'entryId' => $entryId, 'deposit' => $depositStatus];
    }

    /**
     * Roll back a logged change set. A field is restored only if it still
     * holds the value written by the plugin, so later manual edits are kept.
     */
    public function rollback(string $entryId, bool $deposit): array
    {
        $entry = $this->log->get($entryId);
        if (!$entry) {
            throw new \InvalidArgumentException(__('plugins.generic.indexingReadiness.error.logEntryNotFound'));
        }
        if (!empty($entry['rolledBack'])) {
            throw new \InvalidArgumentException(__('plugins.generic.indexingReadiness.error.alreadyRolledBack'));
        }

        $submission = $this->getSubmission((int) $entry['submissionId']);
        $publication = Repo::publication()->get((int) $entry['publicationId']);
        if (!$publication || (int) $publication->getData('submissionId') !== (int) $submission->getId()) {
            throw new \InvalidArgumentException(__('plugins.generic.indexingReadiness.error.notFound'));
        }

        $authors = [];
        foreach ($publication->getData('authors') ?? [] as $author) {
            $authors[(int) $author->getId()] = $author;
        }

        $restored = [];
        $kept = [];
        $pubParams = [];
        $authorParams = [];
        $rorResets = [];
        $affiliationDeletes = [];

        foreach ((array) ($entry['changes'] ?? []) as $change) {
            $type = $change['type'] ?? '';
            $locale = $change['locale'] ?? null;
            $after = $change['after'] ?? null;
            $ok = false;

            switch ($type) {
                case 'title':
                case 'abstract':
                    $current = $pubParams[$type] ?? (array) ($publication->getData($type) ?? []);
                    if (($current[$locale] ?? null) === $after) {
                        $current[$locale] = null;
                        $pubParams[$type] = $current;
                        $ok = true;
                    }
                    break;
                case 'keywords':
                    $current = $pubParams['keywords'] ?? (array) ($publication->getData('keywords') ?? []);
                    $names = array_map(fn ($k) => is_array($k) ? ($k['name'] ?? '') : $k, (array) ($current[$locale] ?? []));
                    if ($names === $after) {
                        unset($current[$locale]);
                        $pubParams['keywords'] = $current;
                        $ok = true;
                    }
                    break;
                case 'citationsRaw':
                    if (trim((string) $publication->getData('citationsRaw')) === trim((string) $after)) {
                        $pubParams['citationsRaw'] = '';
                        $ok = true;
                    }
                    break;
                case 'licenseUrl':
                    if ((string) $publication->getData('licenseUrl') === (string) $after) {
                        $pubParams['licenseUrl'] = null;
                        $ok = true;
                    }
                    break;
                case 'pages':
                    if ((string) $publication->getData('pages') === (string) $after) {
                        $pubParams['pages'] = null;
                        $ok = true;
                    }
                    break;
                case 'authorEmail':
                    $author = $authors[(int) ($change['authorId'] ?? 0)] ?? null;
                    if ($author && (string) $author->getData('email') === (string) $after) {
                        $authorParams[(int) $author->getId()]['email'] = '';
                        $ok = true;
                    }
                    break;
                case 'authorAffiliation':
                    $author = $authors[(int) ($change['authorId'] ?? 0)] ?? null;
                    if ($author) {
                        foreach ($author->getAffiliations() as $affiliation) {
                            $current = array_filter((array) ($affiliation->getName() ?? []), fn ($v) => $this->hasText($v));
                            if ((int) $affiliation->getId() === (int) ($change['affiliationId'] ?? 0)
                                && !$affiliation->getRor() && $current == (array) $after) {
                                $affiliationDeletes[] = $affiliation;
                                $ok = true;
                            }
                        }
                    }
                    break;
                case 'authorName':
                    $author = $authors[(int) ($change['authorId'] ?? 0)] ?? null;
                    if ($author) {
                        $id = (int) $author->getId();
                        $given = $authorParams[$id]['givenName'] ?? (array) ($author->getData('givenName') ?? []);
                        $family = $authorParams[$id]['familyName'] ?? (array) ($author->getData('familyName') ?? []);
                        if (($given[$locale] ?? '') === ($after['givenName'] ?? '') && ($family[$locale] ?? '') === ($after['familyName'] ?? '')) {
                            $given[$locale] = null;
                            $family[$locale] = null;
                            $authorParams[$id]['givenName'] = $given;
                            $authorParams[$id]['familyName'] = $family;
                            $ok = true;
                        }
                    }
                    break;
                case 'authorOrcid':
                    $author = $authors[(int) ($change['authorId'] ?? 0)] ?? null;
                    if ($author && (string) $author->getData('orcid') === (string) $after && !$author->getData('orcidIsVerified')) {
                        $authorParams[(int) $author->getId()]['orcid'] = null;
                        $ok = true;
                    }
                    break;
                case 'affiliationRor':
                    $author = $authors[(int) ($change['authorId'] ?? 0)] ?? null;
                    if ($author) {
                        foreach ($author->getAffiliations() as $affiliation) {
                            if ((int) $affiliation->getId() === (int) ($change['affiliationId'] ?? 0)
                                && (string) $affiliation->getRor() === (string) $after
                                && $this->hasAnyName($affiliation->getName())) {
                                $rorResets[] = $affiliation;
                                $ok = true;
                            }
                        }
                    }
                    break;
            }

            if ($ok) {
                $restored[] = $change;
            } else {
                $kept[] = $change;
            }
        }

        if ($pubParams) {
            Repo::publication()->edit($publication, $pubParams);
        }
        foreach ($authorParams as $authorId => $params) {
            Repo::author()->edit($authors[$authorId], $params);
        }
        foreach ($rorResets as $affiliation) {
            Repo::affiliation()->edit($affiliation, ['ror' => null]);
        }
        foreach ($affiliationDeletes as $affiliation) {
            Repo::affiliation()->delete($affiliation);
        }

        if ($restored) {
            $this->afterChange($submission);
        }
        $depositStatus = ($restored && $deposit) ? $this->deposit($submission) : null;

        $this->log->markRolledBack($entryId, [
            'date' => Core::getCurrentDate(),
            'userName' => $this->user ? $this->user->getFullName() : '',
            'restored' => count($restored),
            'kept' => count($kept),
        ]);

        return ['restored' => $restored, 'kept' => $kept, 'deposit' => $depositStatus];
    }

    /**
     * Reindex and mark DOIs stale, so the registration agency gets the update.
     */
    protected function afterChange(Submission $submission): void
    {
        $submission = Repo::submission()->get($submission->getId());
        try {
            $searchIndex = Application::getSubmissionSearchIndex();
            $searchIndex->submissionMetadataChanged($submission);
            $searchIndex->submissionChangesFinished();
        } catch (\Throwable $e) {
            // Search index problems must not block metadata changes.
        }
        $doiIds = Repo::doi()->getDoisForSubmission((int) $submission->getId());
        if ($doiIds) {
            Repo::doi()->markStale($doiIds);
        }
    }

    /**
     * Queue a deposit of the submission's DOIs with the configured agency.
     *
     * Only updates of DOIs that were registered before are sent: re-depositing
     * metadata is free, while the first registration of a DOI is a paid
     * operation that the editor starts in the DOI management section.
     */
    protected function deposit(Submission $submission): string
    {
        $doiIds = Repo::doi()->getDoisForSubmission((int) $submission->getId());
        if (!$doiIds) {
            return 'no-doi';
        }
        foreach ($doiIds as $doiId) {
            $doi = Repo::doi()->get((int) $doiId);
            if ($doi && (int) $doi->getStatus() === Doi::STATUS_UNREGISTERED) {
                return 'unregistered';
            }
        }
        $agency = $this->context->getConfiguredDoiAgency();
        if (!$agency instanceof IDoiRegistrationAgency) {
            return 'no-agency';
        }
        dispatch(new DepositSubmission((int) $submission->getId(), $this->context, $agency));
        Repo::doi()->markSubmitted($doiIds);
        return 'queued';
    }

    protected function getSubmission(int $submissionId): Submission
    {
        $submission = Repo::submission()->get($submissionId);
        if (!$submission
            || (int) $submission->getData('contextId') !== (int) $this->context->getId()
            || (int) $submission->getData('status') !== Submission::STATUS_PUBLISHED) {
            throw new \InvalidArgumentException(__('plugins.generic.indexingReadiness.error.notFound'));
        }
        return $submission;
    }

    protected function requireLocale(array $op, array $locales): string
    {
        $locale = (string) ($op['locale'] ?? '');
        if (!in_array($locale, $locales, true)) {
            throw new SkipException(__('plugins.generic.indexingReadiness.skip.locale', ['locale' => $locale]));
        }
        return $locale;
    }

    protected function requireAuthor(array $op, array $authors)
    {
        $author = $authors[(int) ($op['authorId'] ?? 0)] ?? null;
        if (!$author) {
            throw new SkipException(__('plugins.generic.indexingReadiness.skip.notFound'));
        }
        return $author;
    }

    protected function hasText($value): bool
    {
        return trim(html_entity_decode(strip_tags((string) ($value ?? '')), ENT_QUOTES, 'UTF-8')) !== '';
    }

    protected function hasAnyName($names): bool
    {
        foreach ((array) ($names ?? []) as $name) {
            if ($this->hasText($name)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Plain text from a proposal: control characters removed, spaces collapsed.
     * Markup is not interpreted; values are escaped where OJS stores HTML.
     */
    protected function cleanText(string $value, int $max): string
    {
        $value = preg_replace('/[\x00-\x1F\x7F]/u', ' ', $value) ?? '';
        $value = trim(preg_replace('/[\s\x{00A0}]+/u', ' ', $value) ?? '');
        return mb_substr($value, 0, $max);
    }

    /**
     * Like cleanText(), but keeps blank lines that separate paragraphs.
     */
    protected function cleanMultiline(string $value, int $max): string
    {
        $paragraphs = [];
        foreach (preg_split('/\R\s*\R/u', $value) ?: [] as $part) {
            $part = $this->cleanText(preg_replace('/\s*\R\s*/u', ' ', $part) ?? '', $max);
            if ($part !== '') {
                $paragraphs[] = $part;
            }
        }
        return mb_substr(implode("\n\n", $paragraphs), 0, $max);
    }

    protected function toParagraphs(string $text): string
    {
        $parts = preg_split('/\n\s*\n/u', $text) ?: [$text];
        $html = '';
        foreach ($parts as $part) {
            $part = trim(preg_replace('/\s*\n\s*/u', ' ', $part) ?? '');
            if ($part !== '') {
                $html .= '<p>' . htmlspecialchars($part, ENT_QUOTES, 'UTF-8') . '</p>';
            }
        }
        return $html;
    }

    /**
     * Validate an ORCID iD (format and ISO 7064 11,2 checksum) and return its URI form.
     */
    public function normalizeOrcid(string $value): ?string
    {
        if (!preg_match('/(\d{4})-?(\d{4})-?(\d{4})-?(\d{3}[\dXx])/', $value, $m)) {
            return null;
        }
        $digits = $m[1] . $m[2] . $m[3] . strtoupper($m[4]);
        $total = 0;
        for ($i = 0; $i < 15; $i++) {
            $total = ($total + (int) $digits[$i]) * 2;
        }
        $check = (12 - ($total % 11)) % 11;
        $checkChar = $check === 10 ? 'X' : (string) $check;
        if ($checkChar !== $digits[15]) {
            return null;
        }
        return 'https://orcid.org/' . implode('-', str_split($digits, 4));
    }
}
