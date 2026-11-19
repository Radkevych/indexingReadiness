<?php

/**
 * @file plugins/generic/indexingReadiness/IndexingReadinessPlugin.php
 *
 * Distributed under the GNU GPL v3.
 *
 * @class IndexingReadinessPlugin
 *
 * @brief Adds an "Indexing readiness" tab to Settings > Distribution: an audit of
 *  all published articles for Google Scholar, ResearchGate, Crossref-based
 *  aggregators (OpenAlex, Semantic Scholar, Dimensions) and OAI-PMH harvesters
 *  (BASE, OpenAIRE, DOAJ), plus confirmed filling of missing metadata from
 *  PDF galleys, ORCID, ROR, transliteration and journal settings.
 *
 *  Compatible with OJS 3.5.
 */

namespace APP\plugins\generic\indexingReadiness;

use APP\core\Application;
use PKP\core\PKPApplication;
use PKP\plugins\GenericPlugin;
use PKP\plugins\Hook;

class IndexingReadinessPlugin extends GenericPlugin
{
    /** Page name used in URLs: /{journal}/{locale}/indexingreadiness */
    public const PAGE = 'indexingreadiness';

    /**
     * @copydoc Plugin::register()
     *
     * @param null|mixed $mainContextId
     */
    public function register($category, $path, $mainContextId = null)
    {
        $success = parent::register($category, $path, $mainContextId);
        if (!$success || Application::isUnderMaintenance()) {
            return $success;
        }
        if ($this->getEnabled($mainContextId)) {
            Hook::add('Template::Settings::distribution', $this->addDistributionTab(...));
            Hook::add('LoadHandler', $this->setPageHandler(...));
        }
        return $success;
    }

    /**
     * Append the "Indexing readiness" tab to Settings > Distribution.
     *
     * The report itself is served by IndexingReadinessHandler and shown in an iframe,
     * so that it does not depend on the Vue build of the settings page and
     * is loaded only when the tab is opened.
     */
    public function addDistributionTab(string $hookName, array $args): bool
    {
        $output = &$args[2];
        $request = Application::get()->getRequest();
        $context = $request->getContext();
        if (!$context) {
            return Hook::CONTINUE;
        }

        $reportUrl = $request->getDispatcher()->url(
            $request,
            PKPApplication::ROUTE_PAGE,
            $context->getPath(),
            self::PAGE,
            'index'
        );

        $label = htmlspecialchars(__('plugins.generic.indexingReadiness.tab'), ENT_QUOTES, 'UTF-8');
        $title = htmlspecialchars(__('plugins.generic.indexingReadiness.name'), ENT_QUOTES, 'UTF-8');
        $src = htmlspecialchars($reportUrl, ENT_QUOTES, 'UTF-8');

        $output .= '<tab id="indexingReadiness" label="' . $label . '">'
            . '<iframe src="' . $src . '" title="' . $title . '" loading="lazy" '
            . 'style="width:100%;min-height:720px;border:0;display:block;background:transparent"></iframe>'
            . '</tab>';

        return Hook::CONTINUE;
    }

    /**
     * Route /indexingreadiness/* requests to the plugin handler.
     */
    public function setPageHandler(string $hookName, array $args): bool
    {
        $page = $args[0];
        $handler = &$args[3];
        if ($page !== self::PAGE) {
            return Hook::CONTINUE;
        }
        $handler = new IndexingReadinessHandler($this);
        return Hook::ABORT;
    }

    /**
     * Public URL of a static file inside the plugin directory.
     */
    public function getAssetUrl(string $file): string
    {
        $request = Application::get()->getRequest();
        $version = $this->getCurrentVersion();
        $versionString = $version ? $version->getVersionString() : '1';
        return $request->getBaseUrl() . '/' . $this->getPluginPath() . '/' . $file
            . '?v=' . rawurlencode($versionString);
    }

    /**
     * @copydoc Plugin::getDisplayName()
     */
    public function getDisplayName()
    {
        return __('plugins.generic.indexingReadiness.name');
    }

    /**
     * @copydoc Plugin::getDescription()
     */
    public function getDescription()
    {
        return __('plugins.generic.indexingReadiness.description');
    }
}
