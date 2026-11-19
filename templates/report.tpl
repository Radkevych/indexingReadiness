{**
 * plugins/generic/indexingReadiness/templates/report.tpl
 *
 * Distributed under the GNU GPL v3.
 *
 * Standalone report page shown inside the "Indexing readiness" tab
 * of Settings > Distribution.
 *}
<!DOCTYPE html>
<html lang="{$irLang|escape}">
<head>
	<meta charset="utf-8">
	<meta name="robots" content="noindex, nofollow">
	<title>{$irPageTitle|escape}</title>
	<link rel="stylesheet" href="{$irCssUrl|escape}">
</head>
<body>
	<div id="ir-app" class="rg">
		<p class="rg-muted">{$irLoading|escape}</p>
	</div>
	<script type="application/json" id="ir-config">{$irConfigJson nofilter}</script>
	<script src="{$irSourcesJsUrl|escape}"></script>
	<script src="{$irJsUrl|escape}"></script>
</body>
</html>
