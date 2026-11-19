<?php

/**
 * @file plugins/generic/indexingReadiness/classes/ReadinessCollector.php
 *
 * Distributed under the GNU GPL v3.
 *
 * @class ReadinessCollector
 *
 * @brief Collects journal settings and per-article metadata relevant for
 *  indexing services. Evaluation rules and proposals live in js/report.js.
 */

namespace APP\plugins\generic\indexingReadiness\classes;

use APP\core\Request;
use APP\facades\Repo;
use APP\issue\Issue;
use APP\journal\Journal;
use APP\plugins\generic\indexingReadiness\IndexingReadinessPlugin;
use APP\submission\Submission;
use PKP\context\Context;
use PKP\core\PKPApplication;
use PKP\db\DAORegistry;
use PKP\doi\Doi;
use PKP\plugins\PluginSettingsDAO;

class ReadinessCollector
{
    /** @var Journal */
    protected $context;

    /** @var array<int, ?Issue> */
    protected array $issueCache = [];

    public function __construct(protected Request $request)
    {
        $this->context = $request->getContext();
    }

    public function collect(): array
    {
        return [
            'generatedAt' => date('c'),
            'journal' => $this->collectJournal(),
            'articles' => $this->collectArticles(),
        ];
    }

    /**
     * The locale key used for English metadata in this journal, if enabled.
     */
    public static function englishLocale(Context $context): ?string
    {
        foreach ($context->getSupportedSubmissionMetadataLocales() as $locale) {
            if (preg_match('/^en(_|$)/', $locale)) {
                return $locale;
            }
        }
        return null;
    }

    protected function collectJournal(): array
    {
        $context = $this->context;
        $contextId = (int) $context->getId();

        return [
            'id' => $contextId,
            'name' => (string) $context->getLocalizedName(),
            'path' => (string) $context->getPath(),
            'primaryLocale' => (string) $context->getPrimaryLocale(),
            'metadataLocales' => array_values($context->getSupportedSubmissionMetadataLocales()),
            'englishLocale' => self::englishLocale($context),
            'onlineIssn' => (string) ($context->getData('onlineIssn') ?? ''),
            'printIssn' => (string) ($context->getData('printIssn') ?? ''),
            'publisherInstitution' => (string) ($context->getData('publisherInstitution') ?? ''),
            'publishingMode' => (int) ($context->getData('publishingMode') ?? Journal::PUBLISHING_MODE_OPEN),
            'restrictSiteAccess' => (bool) $context->getData('restrictSiteAccess'),
            'restrictArticleAccess' => (bool) $context->getData('restrictArticleAccess'),
            'enableOai' => (bool) ($context->getData('enableOai') ?? true),
            'licenseUrl' => (string) ($context->getData('licenseUrl') ?? ''),
            'doisEnabled' => (bool) $context->getData(Context::SETTING_ENABLE_DOIS),
            'doiPrefix' => (string) ($context->getData(Context::SETTING_DOI_PREFIX) ?? ''),
            'registrationAgency' => (string) ($context->getData(Context::SETTING_CONFIGURED_REGISTRATION_AGENCY) ?? ''),
            'automaticDoiDeposit' => (bool) $context->getData(Context::SETTING_DOI_AUTOMATIC_DEPOSIT),
            'rorRegistrySize' => $this->rorRegistrySize(),
            'plugins' => [
                'googleScholar' => $this->isPluginEnabled($contextId, 'googlescholarplugin'),
                'crossref' => $this->isPluginEnabled($contextId, 'crossrefplugin'),
                'crossrefReferenceLinking' => $this->isPluginEnabled($contextId, 'crossrefreferencelinkingplugin'),
                'dublinCore' => $this->isPluginEnabled($contextId, 'dublincoremetaplugin'),
            ],
            'urls' => [
                'doiManagement' => $this->pageUrl('dois'),
                'plugins' => $this->pageUrl('management', 'settings', ['website'], 'plugins'),
                'distribution' => $this->pageUrl('management', 'settings', ['distribution']),
                'contextSettings' => $this->pageUrl('management', 'settings', ['context']),
                'access' => $this->pageUrl('management', 'settings', ['access']),
                'oai' => $this->pageUrl('oai', null, null, null, false),
            ],
        ];
    }

    protected function collectArticles(): array
    {
        $submissions = Repo::submission()
            ->getCollector()
            ->filterByContextIds([(int) $this->context->getId()])
            ->filterByStatus([Submission::STATUS_PUBLISHED])
            ->orderBy(\APP\submission\Collector::ORDERBY_DATE_PUBLISHED)
            ->getMany();

        $articles = [];
        foreach ($submissions as $submission) {
            try {
                $row = $this->collectArticle($submission);
                if ($row !== null) {
                    $articles[] = $row;
                }
            } catch (\Throwable $e) {
                $articles[] = [
                    'id' => (int) $submission->getId(),
                    'title' => '#' . $submission->getId(),
                    'loadError' => $e->getMessage(),
                ];
            }
        }
        return $articles;
    }

    protected function collectArticle(Submission $submission): ?array
    {
        $publication = $submission->getCurrentPublication();
        if (!$publication) {
            return null;
        }

        $primaryLocale = (string) ($publication->getData('locale') ?? $submission->getData('locale') ?? '');
        $bestId = $publication->getData('urlPath') ?: $submission->getId();

        $titles = $this->nonEmptyLocalized($publication->getData('title'));

        $abstracts = [];
        foreach ((array) ($publication->getData('abstract') ?? []) as $locale => $text) {
            $plain = trim(html_entity_decode(strip_tags((string) $text), ENT_QUOTES, 'UTF-8'));
            if ($plain !== '') {
                $abstracts[$locale] = mb_strlen($plain);
            }
        }

        $keywords = [];
        foreach ((array) ($publication->getData('keywords') ?? []) as $locale => $list) {
            $count = 0;
            foreach ((array) $list as $keyword) {
                $value = is_array($keyword) ? ($keyword['name'] ?? '') : $keyword;
                if (trim((string) $value) !== '') {
                    $count++;
                }
            }
            if ($count > 0) {
                $keywords[$locale] = $count;
            }
        }

        $referencesCount = 0;
        $citations = $publication->getData('citations');
        if ($citations instanceof \Traversable) {
            $referencesCount = iterator_count($citations);
        } elseif (is_array($citations)) {
            $referencesCount = count($citations);
        }

        $authors = [];
        foreach ($publication->getData('authors') ?? [] as $author) {
            $affiliations = [];
            foreach ($author->getAffiliations() as $affiliation) {
                $names = [];
                foreach ((array) ($affiliation->getName() ?? []) as $locale => $name) {
                    if (trim((string) $name) !== '') {
                        $names[$locale] = trim((string) $name);
                    }
                }
                $display = trim((string) ($affiliation->getLocalizedName($primaryLocale) ?? ''));
                if ($display === '' && !$names) {
                    continue;
                }
                $affiliations[] = [
                    'id' => (int) $affiliation->getId(),
                    'name' => $display !== '' ? $display : (string) reset($names),
                    'names' => (object) $names,
                    'ror' => (string) ($affiliation->getRor() ?? ''),
                ];
            }
            $authors[] = [
                'id' => (int) $author->getId(),
                'name' => (string) $author->getFullName(false, false, $primaryLocale),
                'givenName' => (object) $this->nonEmptyStrings($author->getData('givenName')),
                'familyName' => (object) $this->nonEmptyStrings($author->getData('familyName')),
                'orcid' => (string) ($author->getOrcid() ?? ''),
                'hasEmail' => trim((string) $author->getData('email')) !== '',
                'orcidIsVerified' => (bool) $author->getData('orcidIsVerified'),
                'affiliations' => $affiliations,
            ];
        }

        $doi = (string) ($publication->getDoi() ?? '');
        $doiStatus = null;
        $doiObject = $publication->getData('doiObject');
        if ($doiObject instanceof Doi) {
            $doiStatus = (int) $doiObject->getStatus();
        }

        $fileService = app()->get('file');
        $galleys = [];
        foreach ($publication->getData('galleys') ?? [] as $galley) {
            $mimetype = '';
            $size = null;
            $fileId = $galley->getData('submissionFileId');
            if ($fileId) {
                $submissionFile = Repo::submissionFile()->get((int) $fileId);
                if ($submissionFile) {
                    $mimetype = (string) $submissionFile->getData('mimetype');
                    try {
                        $file = $fileService->get($submissionFile->getData('fileId'));
                        if ($file && $fileService->fs->has($file->path)) {
                            $size = (int) $fileService->fs->fileSize($file->path);
                        }
                    } catch (\Throwable $e) {
                        $size = null;
                    }
                }
            }
            $galleys[] = [
                'id' => (int) $galley->getId(),
                'label' => (string) $galley->getLabel(),
                'mimetype' => $mimetype,
                'size' => $size,
                'remote' => (string) ($galley->getData('urlRemote') ?? '') !== '',
                'pdfUrl' => $mimetype === 'application/pdf'
                    ? $this->pageUrl(IndexingReadinessPlugin::PAGE, 'pdf', [(string) $galley->getId()])
                    : '',
            ];
        }

        $issue = $this->getIssue((int) ($publication->getData('issueId') ?? 0));

        return [
            'id' => (int) $submission->getId(),
            'publicationId' => (int) $publication->getId(),
            'title' => (string) ($publication->getLocalizedFullTitle(null) ?? ''),
            'titles' => (object) $this->plainLocalized($publication->getData('title')),
            'titleLocales' => array_keys($titles),
            'primaryLocale' => $primaryLocale,
            'datePublished' => (string) ($publication->getData('datePublished') ?? ''),
            'issue' => $issue ? (string) $issue->getIssueIdentification() : '',
            'pages' => (string) ($publication->getData('pages') ?? ''),
            'doi' => $doi,
            'doiStatus' => $doiStatus,
            'abstracts' => (object) $abstracts,
            'keywords' => (object) $keywords,
            'referencesCount' => $referencesCount,
            'authors' => $authors,
            'licenseUrl' => (string) ($publication->getData('licenseUrl') ?? ''),
            'galleys' => $galleys,
            'openAccess' => $this->isOpenAccess($publication, $issue),
            'url' => $this->pageUrl('article', 'view', [(string) $bestId], null, false),
            'editUrl' => $this->pageUrl('dashboard', 'editorial', null, null, true, ['workflowSubmissionId' => $submission->getId()]),
        ];
    }

    protected function isOpenAccess($publication, ?Issue $issue): bool
    {
        $context = $this->context;
        if ($context->getData('restrictSiteAccess') || $context->getData('restrictArticleAccess')) {
            return false;
        }
        $mode = (int) ($context->getData('publishingMode') ?? Journal::PUBLISHING_MODE_OPEN);
        if ($mode === Journal::PUBLISHING_MODE_OPEN) {
            return true;
        }
        if ($mode === Journal::PUBLISHING_MODE_NONE) {
            return false;
        }
        if ((int) $publication->getData('accessStatus') === Submission::ARTICLE_ACCESS_OPEN) {
            return true;
        }
        if ($issue) {
            if ((int) $issue->getAccessStatus() === Issue::ISSUE_ACCESS_OPEN) {
                return true;
            }
            $openDate = $issue->getOpenAccessDate();
            if ($openDate && strtotime($openDate) <= time()) {
                return true;
            }
        }
        return false;
    }

    protected function getIssue(int $issueId): ?Issue
    {
        if ($issueId <= 0) {
            return null;
        }
        if (!array_key_exists($issueId, $this->issueCache)) {
            $this->issueCache[$issueId] = Repo::issue()->get($issueId);
        }
        return $this->issueCache[$issueId];
    }

    /**
     * Number of organisations in the local ROR registry (filled by the
     * "Update ROR registry" scheduled task of OJS 3.5).
     */
    protected function rorRegistrySize(): int
    {
        try {
            return (int) Repo::ror()->getCollector()->limit(1)->getCount();
        } catch (\Throwable $e) {
            return 0;
        }
    }

    protected function isPluginEnabled(int $contextId, string $pluginName): bool
    {
        /** @var PluginSettingsDAO $dao */
        $dao = DAORegistry::getDAO('PluginSettingsDAO');
        return (bool) $dao->getSetting($contextId, $pluginName, 'enabled');
    }

    protected function nonEmptyLocalized($value): array
    {
        $result = [];
        foreach ((array) ($value ?? []) as $locale => $text) {
            if (trim(strip_tags((string) $text)) !== '') {
                $result[$locale] = true;
            }
        }
        return $result;
    }

    protected function plainLocalized($value): array
    {
        $result = [];
        foreach ((array) ($value ?? []) as $locale => $text) {
            $plain = trim(html_entity_decode(strip_tags((string) $text), ENT_QUOTES, 'UTF-8'));
            if ($plain !== '') {
                $result[$locale] = $plain;
            }
        }
        return $result;
    }

    protected function nonEmptyStrings($value): array
    {
        $result = [];
        foreach ((array) ($value ?? []) as $locale => $text) {
            if (trim((string) $text) !== '') {
                $result[$locale] = trim((string) $text);
            }
        }
        return $result;
    }

    protected function pageUrl(
        string $page,
        ?string $op = null,
        ?array $path = null,
        ?string $anchor = null,
        bool $withLocale = true,
        ?array $params = null
    ): string {
        return $this->request->getDispatcher()->url(
            $this->request,
            PKPApplication::ROUTE_PAGE,
            $this->context->getPath(),
            $page,
            $op,
            $path,
            $params,
            $anchor,
            false,
            $withLocale ? null : ''
        );
    }
}
