<?php

/**
 * @file plugins/generic/indexingReadiness/IndexingReadinessHandler.php
 *
 * Distributed under the GNU GPL v3.
 *
 * @class IndexingReadinessHandler
 *
 * @brief Report page, its data, PDF access for analysis, applying and rolling
 *  back confirmed metadata additions. Available only to journal managers with
 *  settings access and to site administrators.
 */

namespace APP\plugins\generic\indexingReadiness;

use APP\core\Request;
use APP\facades\Repo;
use APP\handler\Handler;
use APP\plugins\generic\indexingReadiness\classes\ChangeApplier;
use APP\plugins\generic\indexingReadiness\classes\ChangeLog;
use APP\plugins\generic\indexingReadiness\classes\ReadinessCollector;
use APP\submission\Submission;
use APP\template\TemplateManager;
use PKP\core\PKPApplication;
use PKP\facades\Locale;
use PKP\security\authorization\CanAccessSettingsPolicy;
use PKP\security\authorization\ContextAccessPolicy;
use PKP\security\Role;

class IndexingReadinessHandler extends Handler
{
    public function __construct(protected IndexingReadinessPlugin $plugin)
    {
        parent::__construct();
        $this->addRoleAssignment(
            [Role::ROLE_ID_SITE_ADMIN, Role::ROLE_ID_MANAGER],
            ['index', 'data', 'pdf', 'apply', 'history', 'rollback']
        );
    }

    /**
     * @copydoc PKPHandler::authorize()
     */
    public function authorize($request, &$args, $roleAssignments)
    {
        $this->addPolicy(new ContextAccessPolicy($request, $roleAssignments));
        $this->addPolicy(new CanAccessSettingsPolicy());
        return parent::authorize($request, $args, $roleAssignments);
    }

    /**
     * Report page shown inside the tab.
     *
     * @param array $args
     * @param Request $request
     */
    public function index($args, $request)
    {
        $context = $request->getContext();
        $url = fn (string $op) => $request->getDispatcher()->url(
            $request,
            PKPApplication::ROUTE_PAGE,
            $context->getPath(),
            IndexingReadinessPlugin::PAGE,
            $op
        );

        $lang = str_starts_with((string) Locale::getLocale(), 'uk') ? 'uk' : 'en';
        $templateMgr = TemplateManager::getManager($request);
        $templateMgr->assign([
            'irPageTitle' => __('plugins.generic.indexingReadiness.name'),
            'irLang' => $lang,
            'irLoading' => __('plugins.generic.indexingReadiness.loading'),
            'irCssUrl' => $this->plugin->getAssetUrl('css/report.css'),
            'irSourcesJsUrl' => $this->plugin->getAssetUrl('js/sources.js'),
            'irJsUrl' => $this->plugin->getAssetUrl('js/report.js'),
            'irConfigJson' => json_encode([
                'dataUrl' => $url('data'),
                'applyUrl' => $url('apply'),
                'historyUrl' => $url('history'),
                'rollbackUrl' => $url('rollback'),
                'pdfjsUrl' => $this->plugin->getAssetUrl('lib/pdfjs/pdf.min.js'),
                'pdfjsWorkerUrl' => $this->plugin->getAssetUrl('lib/pdfjs/pdf.worker.min.js'),
                'siteRootUrl' => rtrim($request->getBaseUrl(), '/'),
                'mailto' => (string) $context->getData('contactEmail'),
                'csrfToken' => $request->getSession()->token(),
                'lang' => $lang,
            ], JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ]);
        $templateMgr->display($this->plugin->getTemplateResource('report.tpl'));
    }

    /**
     * Journal settings and per-article metadata (JSON).
     *
     * @param array $args
     * @param Request $request
     */
    public function data($args, $request)
    {
        if (function_exists('set_time_limit')) {
            @set_time_limit(300);
        }
        $collector = new ReadinessCollector($request);
        return $this->json($collector->collect());
    }

    /**
     * Stream a PDF galley for in-browser analysis without recording a
     * download in usage statistics.
     *
     * @param array $args [galleyId]
     * @param Request $request
     */
    public function pdf($args, $request)
    {
        $context = $request->getContext();
        $galley = Repo::galley()->get((int) ($args[0] ?? 0));
        $publication = $galley ? Repo::publication()->get((int) $galley->getData('publicationId')) : null;
        $submission = $publication ? Repo::submission()->get((int) $publication->getData('submissionId')) : null;
        if (!$submission || (int) $submission->getData('contextId') !== (int) $context->getId()) {
            http_response_code(404);
            return 'Not found';
        }
        $submissionFile = $galley->getData('submissionFileId')
            ? Repo::submissionFile()->get((int) $galley->getData('submissionFileId'))
            : null;
        if (!$submissionFile || $submissionFile->getData('mimetype') !== 'application/pdf') {
            http_response_code(404);
            return 'Not found';
        }
        app()->get('file')->download(
            (int) $submissionFile->getData('fileId'),
            'article-' . $submission->getId() . '-' . $galley->getId() . '.pdf',
            true
        );
    }

    /**
     * Apply confirmed changes to one article (POST, JSON body).
     *
     * @param array $args
     * @param Request $request
     */
    public function apply($args, $request)
    {
        if ($error = $this->checkPost($request)) {
            return $error;
        }
        $body = $this->jsonBody();
        $applier = $this->makeApplier($request);
        try {
            $result = $applier->apply(
                (int) ($body['submissionId'] ?? 0),
                (array) ($body['ops'] ?? []),
                !empty($body['deposit']),
                substr((string) ($body['source'] ?? ''), 0, 200)
            );
        } catch (\InvalidArgumentException $e) {
            return $this->json(['error' => $e->getMessage()], 400);
        } catch (\Throwable $e) {
            error_log('indexingReadiness apply: ' . $e);
            return $this->json(['error' => __('plugins.generic.indexingReadiness.error.server', ['message' => $e->getMessage()])], 500);
        }
        return $this->json($result);
    }

    /**
     * Change log for this journal.
     *
     * @param array $args
     * @param Request $request
     */
    public function history($args, $request)
    {
        $log = new ChangeLog((int) $request->getContext()->getId());
        return $this->json(['entries' => array_slice($log->all(), 0, 300)]);
    }

    /**
     * Roll back one change set (POST, JSON body).
     *
     * @param array $args
     * @param Request $request
     */
    public function rollback($args, $request)
    {
        if ($error = $this->checkPost($request)) {
            return $error;
        }
        $body = $this->jsonBody();
        $applier = $this->makeApplier($request);
        try {
            $result = $applier->rollback((string) ($body['entryId'] ?? ''), !empty($body['deposit']));
        } catch (\InvalidArgumentException $e) {
            return $this->json(['error' => $e->getMessage()], 400);
        } catch (\Throwable $e) {
            error_log('indexingReadiness rollback: ' . $e);
            return $this->json(['error' => __('plugins.generic.indexingReadiness.error.server', ['message' => $e->getMessage()])], 500);
        }
        return $this->json($result);
    }

    protected function makeApplier(Request $request): ChangeApplier
    {
        $context = $request->getContext();
        return new ChangeApplier($context, new ChangeLog((int) $context->getId()), $request->getUser());
    }

    /**
     * Require POST and a valid CSRF token in the X-Csrf-Token header.
     */
    protected function checkPost(Request $request): ?string
    {
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
            return $this->json(['error' => 'POST required'], 405);
        }
        $token = (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
        if ($token === '' || !hash_equals((string) $request->getSession()->token(), $token)) {
            return $this->json(['error' => __('plugins.generic.indexingReadiness.error.csrf')], 403);
        }
        return null;
    }

    protected function jsonBody(): array
    {
        $data = json_decode((string) file_get_contents('php://input'), true);
        return is_array($data) ? $data : [];
    }

    protected function json($payload, int $status = 200): string
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        return json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
    }
}
