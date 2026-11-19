/**
 * plugins/generic/indexingReadiness/js/report.js
 *
 * Distributed under the GNU GPL v3.
 *
 * Звіт про готовність статей до індексування (Google Scholar, ResearchGate,
 * агрегатори на основі Crossref, системи OAI-PMH) і доповнення метаданих
 * з підтвердженням редактора. Інтерфейс українською та англійською.
 */
(function () {
	'use strict';

	var IR = window.IR;
	var cfg = JSON.parse(document.getElementById('ir-config').textContent);
	var app = document.getElementById('ir-app');

	// ------------------------------------------------------------------
	// Мова інтерфейсу
	// ------------------------------------------------------------------

	var LANG_KEY = 'indexingReadiness:lang';
	var LANG = cfg.lang === 'uk' ? 'uk' : 'en';
	try {
		var savedLang = localStorage.getItem(LANG_KEY);
		if (savedLang === 'uk' || savedLang === 'en') { LANG = savedLang; }
	} catch (e) { /* сховище недоступне */ }

	/** Рядок поточною мовою. */
	function L(uk, en) { return LANG === 'en' ? en : uk; }

	/** Форма слова для числа: uk — [1, 2–4, 5+], en — [1, інші]. */
	function P(n, uk, en) {
		if (LANG === 'en') { return n === 1 ? en[0] : en[1]; }
		var a = n % 10, b = n % 100;
		if (a === 1 && b !== 11) { return uk[0]; }
		if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) { return uk[1]; }
		return uk[2];
	}

	function sevInfo() {
		return {
			critical: { label: L('Критично', 'Critical'), weight: 25, cls: 'crit', order: 0 },
			important: { label: L('Важливо', 'Important'), weight: 10, cls: 'imp', order: 1 },
			minor: { label: L('Бажано', 'Desirable'), weight: 3, cls: 'min', order: 2 }
		};
	}
	var SEV = sevInfo();

	var SYSTEMS = [
		{ id: 'gs', short: 'GS', name: 'Google Scholar' },
		{ id: 'rg', short: 'RG', name: 'ResearchGate' },
		{ id: 'cr', short: 'CR', name: 'OpenAlex, Semantic Scholar, Dimensions' },
		{ id: 'oai', short: 'OAI', name: 'BASE, OpenAIRE, DOAJ' }
	];

	var DOI_STATUS = { UNREGISTERED: 1, SUBMITTED: 2, REGISTERED: 3, ERROR: 4, STALE: 5 };
	var READY = 85;
	var TOP_LIMIT = 3;

	var state = {
		data: null,
		crossref: {}, crossrefCheckedAt: null,
		pages: {}, pagesCheckedAt: null,
		pdf: {}, pdfCheckedAt: null,
		parsed: {},
		robots: null, oai: null,
		proposals: {}, proposalsReady: false,
		results: {},
		history: null, showHistory: false, historyOpen: {}, historyLimit: 0, confirmRollback: null,
		deposit: true, confirmAll: false, showAllTop: false,
		running: '', progress: '', notice: '',
		filter: 'all', system: 'all', query: '', open: {}, selected: {}, confirmBatch: false
	};

	var STORAGE_KEY = 'indexingReadiness:' + (cfg.dataUrl || '');
	var STORAGE_TTL = 24 * 3600 * 1000;

	// ------------------------------------------------------------------
	// Допоміжні функції
	// ------------------------------------------------------------------

	function esc(v) {
		return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}
	function keys(o) { return o ? Object.keys(o) : []; }
	function isEnglish(loc) { return /^en(\b|_|-|$)/i.test(loc || ''); }
	function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
	function fmtDate(v) {
		if (!v) { return ''; }
		var d = new Date(String(v).replace(' ', 'T'));
		return isNaN(d.getTime()) ? String(v) : d.toLocaleString(LANG === 'en' ? 'en-GB' : 'uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
	function fmtSize(b) { return b == null ? '' : (LANG === 'en' ? (b / 1048576).toFixed(1) + ' MB' : (b / 1048576).toFixed(1).replace('.', ',') + ' МБ'); }
	function pathOf(url) { try { return new URL(url, location.href).pathname; } catch (e) { return '/'; } }
	function q(s) { return L('«' + s + '»', '“' + s + '”'); }

	function fitFrame() {
		try {
			if (window.frameElement) {
				var bottom = app.getBoundingClientRect().bottom + (window.scrollY || 0);
				window.frameElement.style.height = Math.ceil(bottom + 24) + 'px';
			}
		} catch (e) { /* інший домен */ }
	}

	function saveCache() {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify({
				savedAt: Date.now(),
				crossref: state.crossref, crossrefCheckedAt: state.crossrefCheckedAt,
				pages: state.pages, pagesCheckedAt: state.pagesCheckedAt,
				pdf: state.pdf, pdfCheckedAt: state.pdfCheckedAt
			}));
		} catch (e) { /* сховище недоступне */ }
	}
	function loadCache() {
		try {
			var c = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
			if (!c || Date.now() - c.savedAt > STORAGE_TTL) { return; }
			['crossref', 'crossrefCheckedAt', 'pages', 'pagesCheckedAt', 'pdf', 'pdfCheckedAt'].forEach(function (k) {
				if (c[k] != null) { state[k] = c[k]; }
			});
		} catch (e) { /* пошкоджений кеш */ }
	}

	function postJson(url, body) {
		return fetch(url, {
			method: 'POST', credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', 'X-Csrf-Token': cfg.csrfToken, 'Accept': 'application/json' },
			body: JSON.stringify(body)
		}).then(function (res) {
			return res.json().catch(function () { return {}; }).then(function (j) {
				if (!res.ok) { throw new Error(j.error || ('HTTP ' + res.status)); }
				return j;
			});
		});
	}

	/** Проблема з рівнем для кожної системи, напр. sys = { gs: 'critical', rg: 'important' }. */
	function issue(id, sys, text, fix, link) {
		var worst = 'minor';
		keys(sys).forEach(function (s) { if (SEV[sys[s]].order < SEV[worst].order) { worst = sys[s]; } });
		return { id: id, sys: sys, sev: worst, text: text, fix: fix || '', link: link || '' };
	}
	function S(list, sev) {
		var o = {};
		list.split(' ').forEach(function (s) { o[s] = sev; });
		return o;
	}
	function M() {
		var o = {}, args = arguments;
		for (var i = 0; i < args.length; i++) {
			var a = args[i];
			keys(a).forEach(function (k) { o[k] = a[k]; });
		}
		return o;
	}
	var ALL = 'gs rg cr oai';

	// ------------------------------------------------------------------
	// robots.txt і OAI-PMH
	// ------------------------------------------------------------------

	function parseRobots(text) {
		var groups = [], cur = null, lastAgent = false;
		text.split(/\r?\n/).forEach(function (line) {
			line = line.replace(/#.*$/, '').trim();
			var m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
			if (!m) { return; }
			var f = m[1].toLowerCase(), v = m[2].trim();
			if (f === 'user-agent') {
				if (!cur || !lastAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
				cur.agents.push(v.toLowerCase());
				lastAgent = true;
			} else {
				if ((f === 'allow' || f === 'disallow') && cur) { cur.rules.push({ allow: f === 'allow', path: v }); }
				lastAgent = false;
			}
		});
		return groups;
	}
	function robotsAllows(path, agent) {
		if (!state.robots || !state.robots.groups) { return true; }
		var exact = null, star = null;
		state.robots.groups.forEach(function (g) {
			g.agents.forEach(function (a) {
				if (a !== '*' && agent.indexOf(a) !== -1) { exact = g; }
				if (a === '*') { star = g; }
			});
		});
		var group = exact || star;
		if (!group) { return true; }
		var best = null;
		group.rules.forEach(function (r) {
			if (!r.path) { return; }
			var anchored = /\$$/.test(r.path);
			var re = new RegExp('^' + r.path.replace(/\$$/, '').replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + (anchored ? '$' : ''));
			if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) { best = r; }
		});
		return !best || best.allow;
	}
	function checkRobots() {
		var origin;
		try { origin = new URL(cfg.siteRootUrl, location.href).origin; } catch (e) { origin = location.origin; }
		return fetch(origin + '/robots.txt', { credentials: 'omit', cache: 'no-store' })
			.then(function (res) {
				if (!res.ok) { return { status: res.status, groups: [] }; }
				return res.text().then(function (t) { return { status: res.status, groups: parseRobots(t) }; });
			})
			.catch(function (e) { return { error: String(e) }; })
			.then(function (r) { state.robots = r; });
	}
	function checkOai() {
		var url = state.data.journal.urls.oai;
		if (!url) { return Promise.resolve(); }
		return fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + 'verb=Identify', { credentials: 'omit', cache: 'no-store' })
			.then(function (res) {
				return res.text().then(function (t) {
					state.oai = { status: res.status, ok: res.ok && /<Identify>/.test(t) && !/<error\b/.test(t) };
				});
			})
			.catch(function (e) { state.oai = { error: String(e), ok: false }; });
	}

	// ------------------------------------------------------------------
	// Оцінювання журналу
	// ------------------------------------------------------------------

	function evaluateJournal(j) {
		var out = [], u = j.urls || {}, p = j.plugins || {}, dist = u.distribution || '';

		if (j.restrictSiteAccess) {
			out.push(issue('j-site', S(ALL, 'critical'), L('Сайт доступний лише зареєстрованим користувачам.', 'The site is available to registered users only.'),
				L('Вимкніть обмеження доступу до сайту: пошукові роботи й збирачі метаданих не авторизуються.', 'Remove the site access restriction: crawlers and harvesters do not log in.'), u.access));
		}
		if (j.restrictArticleAccess) {
			out.push(issue('j-article-access', S('gs rg oai', 'critical'), L('Перегляд статей потребує входу в систему.', 'Viewing articles requires login.'),
				L('Вимкніть вимогу реєстрації для перегляду статей.', 'Turn off the registration requirement for viewing articles.'), u.access));
		}
		if (j.publishingMode === 2) {
			out.push(issue('j-mode-none', S('gs rg oai', 'important'), L('Журнал не публікує вміст в OJS.', 'The journal does not publish content in OJS.'),
				L('У цьому режимі системи отримують лише метадані без повних текстів.', 'In this mode services receive metadata only, without full texts.'), dist));
		} else if (j.publishingMode === 1) {
			out.push(issue('j-mode-sub', S('gs oai', 'minor'), L('Журнал працює за передплатою.', 'The journal uses subscriptions.'),
				L('Статті поза відкритим доступом індексуються лише на рівні метаданих.', 'Articles outside open access are indexed at the metadata level only.'), dist));
		}
		if (!j.englishLocale) {
			out.push(issue('j-no-en', M(S('rg cr oai', 'important'), { gs: 'minor' }), L('Англійську не ввімкнено як мову метаданих.', 'English is not enabled as a metadata language.'),
				L('Увімкніть англійську для метаданих у «Вебсайт → Налаштування → Мови»: без цього неможливо додати англомовні назви, анотації, ключові слова й імена.',
					'Enable English for metadata in Website → Setup → Languages; otherwise English titles, abstracts, keywords and names cannot be added.'), u.contextSettings));
		}
		if (!p.googleScholar) {
			out.push(issue('j-gs', { gs: 'critical', rg: 'important' }, L('Не ввімкнено «Плагін індексування в Google Академії».', 'The Google Scholar Indexing plugin is disabled.'),
				L('Увімкніть плагін у «Вебсайт → Плагіни»: він формує мітки citation_* на сторінках статей.', 'Enable it in Website → Plugins: it outputs the citation_* tags on article pages.'), u.plugins));
		}
		if (!j.doisEnabled) {
			out.push(issue('j-doi', S('rg cr', 'critical'), L('Присвоєння DOI вимкнено.', 'DOIs are disabled.'),
				L('Увімкніть DOI: ResearchGate, OpenAlex, Semantic Scholar і Dimensions отримують метадані статей через Crossref.',
					'Enable DOIs: ResearchGate, OpenAlex, Semantic Scholar and Dimensions receive article metadata via Crossref.'), dist + '#dois'));
		}
		if (!/crossref/i.test(j.registrationAgency || '')) {
			out.push(issue('j-agency', S('rg cr', 'critical'), L('Агентом реєстрації DOI не обрано Crossref.', 'Crossref is not selected as the DOI registration agency.'),
				L('У «Розповсюдження → DOI → Реєстрація» оберіть Crossref і внесіть облікові дані депонування.', 'In Distribution → DOIs → Registration select Crossref and enter the deposit credentials.'), dist + '#dois'));
		} else if (!p.crossref) {
			out.push(issue('j-crossref-plugin', S('rg cr', 'critical'), L('Не ввімкнено «Плагін менеджера Crossref».', 'The Crossref Manager plugin is disabled.'),
				L('Увімкніть плагін у «Вебсайт → Плагіни».', 'Enable it in Website → Plugins.'), u.plugins));
		}
		if (j.doisEnabled && !j.automaticDoiDeposit) {
			out.push(issue('j-auto', S('rg cr', 'minor'), L('Автоматичне депонування DOI вимкнено.', 'Automatic DOI deposit is off.'),
				L('Увімкніть автоматичне депонування, щоб нові й змінені статті одразу потрапляли до Crossref.', 'Turn on automatic deposit so that new and updated articles reach Crossref without delay.'), dist + '#dois'));
		}
		if (!p.crossrefReferenceLinking) {
			out.push(issue('j-reflink', S('rg cr', 'important'), L('Не ввімкнено плагін Crossref Reference Linking.', 'The Crossref Reference Linking plugin is not enabled.'),
				L('Без нього поле «Посилання» не передається до Crossref і цитування не враховуються. Плагін встановлюється з галереї плагінів.',
					'Without it the References field is not sent to Crossref and citations are not counted. Install it from the Plugin Gallery.'), u.plugins));
		}
		if (!j.onlineIssn && !j.printIssn) {
			out.push(issue('j-issn', M(S('rg cr oai', 'important'), { gs: 'minor' }), L('Не вказано ISSN журналу.', 'The journal ISSN is missing.'),
				L('Внесіть ISSN у налаштуваннях журналу.', 'Enter the ISSN in the journal settings.'), u.contextSettings));
		}
		if (!j.publisherInstitution) {
			out.push(issue('j-publisher', S('cr oai', 'minor'), L('Не вказано видавця.', 'The publisher is missing.'),
				L('Заповніть поле «Видавець».', 'Fill in the Publisher field.'), u.contextSettings));
		}
		if (!j.enableOai) {
			out.push(issue('j-oai', { oai: 'critical' }, L('Протокол OAI-PMH вимкнено.', 'OAI-PMH is disabled.'),
				L('Увімкніть OAI-PMH: через нього метадані збирають BASE, OpenAIRE та інші агрегатори.', 'Enable OAI-PMH: BASE, OpenAIRE and other aggregators harvest metadata through it.'), dist + '#indexing'));
		} else if (state.oai && !state.oai.ok) {
			out.push(issue('j-oai-endpoint', { oai: 'critical' }, L('Точка доступу OAI-PMH не відповідає', 'The OAI-PMH endpoint does not respond') + (state.oai.status ? ' (' + L('код', 'code') + ' ' + state.oai.status + ')' : '') + '.',
				L('Перевірте адресу ', 'Check ') + (j.urls.oai || '') + '?verb=Identify.'));
		}
		if (!j.rorRegistrySize) {
			out.push(issue('j-ror-registry', S('rg cr', 'minor'), L('Локальний реєстр ROR в OJS порожній.', 'The local ROR registry in OJS is empty.'),
				L('Налаштуйте виконання запланованих завдань OJS (завдання оновлення реєстру ROR). Доти плагін не пропонуватиме ROR, бо без реєстру OJS не зможе показати назву установи.',
					'Set up OJS scheduled tasks (the ROR registry update task). Until then the plugin does not propose ROR IDs, because OJS cannot show the organisation name without the registry.')));
		}
		if (!j.licenseUrl) {
			out.push(issue('j-license', M(S('oai', 'important'), { cr: 'minor' }), L('Не обрано типову ліцензію журналу.', 'No default journal licence is selected.'),
				L('Оберіть ліцензію Creative Commons у «Розповсюдження → Ліцензія».', 'Select a Creative Commons licence in Distribution → License.'), dist + '#license'));
		}
		if (state.robots && state.robots.groups && state.data.articles.length) {
			var path = pathOf(state.data.articles[0].url || '/');
			if (!robotsAllows(path, 'googlebot-scholar googlebot') || !robotsAllows(path, 'researchgate')) {
				out.push(issue('j-robots', S('gs rg', 'critical'), L('robots.txt забороняє обхід сторінок статей.', 'robots.txt blocks article pages.'),
					L('Приберіть заборону для «User-agent: *» або дозвольте шляхи /article/.', 'Remove the Disallow rule for “User-agent: *” or allow /article/ paths.')));
			}
		}
		return out;
	}

	// ------------------------------------------------------------------
	// Оцінювання статті
	// ------------------------------------------------------------------

	function hasEnglishName(author) {
		return keys(author.givenName).concat(keys(author.familyName)).some(function (l) {
			return isEnglish(l) && ((author.givenName || {})[l] || (author.familyName || {})[l]);
		});
	}

	function evaluateArticle(a, j) {
		var out = [];
		if (a.loadError) {
			return [issue('a-load', S(ALL, 'critical'), L('Не вдалося прочитати метадані статті.', 'Article metadata could not be read.'), a.loadError)];
		}
		var abstracts = a.abstracts || {}, absLoc = keys(abstracts), authors = a.authors || [], galleys = a.galleys || [];
		var hasPdf = galleys.some(function (g) { return g.mimetype === 'application/pdf'; });
		var onlyRemote = galleys.length && galleys.every(function (g) { return g.remote; });
		var redeposit = L('Депонуйте DOI повторно.', 'Deposit the DOI again.');

		if (!a.doi) {
			out.push(issue('a-no-doi', S('rg cr', 'critical'), L('Статті не присвоєно DOI.', 'The article has no DOI.'),
				L('Присвойте DOI і зареєструйте його в Crossref: через Crossref метадані отримують ResearchGate, OpenAlex, Semantic Scholar і Dimensions.',
					'Assign a DOI and register it with Crossref: ResearchGate, OpenAlex, Semantic Scholar and Dimensions receive metadata via Crossref.')));
		} else if (a.doiStatus === DOI_STATUS.UNREGISTERED) {
			out.push(issue('a-doi-unreg', S('rg cr', 'critical'), L('DOI не зареєстровано в Crossref.', 'The DOI is not registered with Crossref.'),
				L('У розділі «DOI» виконайте дію «Депонувати». Це первинна реєстрація, за яку Crossref стягує плату.', 'Use Deposit in the DOIs section. This is the first registration, which Crossref charges for.')));
		} else if (a.doiStatus === DOI_STATUS.ERROR) {
			out.push(issue('a-doi-error', S('rg cr', 'critical'), L('Помилка депонування DOI.', 'DOI deposit error.'),
				L('Перегляньте повідомлення про помилку в розділі «DOI», виправте метадані й депонуйте повторно.', 'Check the error message in the DOIs section, fix the metadata and deposit again.')));
		} else if (a.doiStatus === DOI_STATUS.STALE) {
			out.push(issue('a-doi-stale', S('rg cr', 'important'), L('DOI потребує синхронізації: метадані змінено після депонування.', 'The DOI needs sync: metadata changed after the deposit.'),
				L('Депонуйте DOI повторно, щоб зміни потрапили до Crossref. Оновлення метаданих безкоштовне.', 'Deposit the DOI again so that the changes reach Crossref. Metadata updates are free.')));
		} else if (a.doiStatus === DOI_STATUS.SUBMITTED) {
			out.push(issue('a-doi-submitted', S('rg cr', 'minor'), L('DOI подано, підтвердження від Crossref ще не надійшло.', 'The DOI is submitted; Crossref has not confirmed it yet.'),
				L('Перевірте статус пізніше.', 'Check the status later.')));
		}

		if (!galleys.length) {
			out.push(issue('a-no-galley', M(S('gs', 'critical'), S('rg oai', 'important')), L('Немає файлу повного тексту.', 'No full-text file.'),
				L('Додайте PDF-файл на вкладці «Публікація → Гранки».', 'Add a PDF on the Publication → Galleys tab.')));
		} else if (onlyRemote) {
			out.push(issue('a-remote', { gs: 'minor' }, L('Повний текст лише на зовнішньому ресурсі.', 'The full text is hosted elsewhere only.'),
				L('Додайте PDF-файл безпосередньо в OJS.', 'Upload the PDF to OJS itself.')));
		} else if (!hasPdf) {
			out.push(issue('a-no-pdf', S('gs rg', 'important'), L('Немає PDF-гранки.', 'No PDF galley.'),
				L('Додайте PDF: Google Scholar і ResearchGate знаходять повний текст за міткою citation_pdf_url, яка формується лише для PDF.',
					'Add a PDF: Google Scholar and ResearchGate find the full text via the citation_pdf_url tag, which is output for PDFs only.')));
		}
		if (!a.openAccess) {
			out.push(issue('a-closed', S('gs rg oai', 'important'), L('Повний текст недоступний без авторизації або передплати.', 'The full text requires login or a subscription.'),
				L('Повний текст індексується лише у відкритому доступі.', 'Full texts are indexed only when openly accessible.')));
		}

		if (!absLoc.length) {
			out.push(issue('a-no-abstract', M(S('rg', 'critical'), S('gs cr oai', 'important')), L('Немає анотації.', 'No abstract.'), L('Додайте анотацію.', 'Add an abstract.')));
		} else {
			if (!absLoc.some(isEnglish)) {
				out.push(issue('a-no-en-abstract', M(S('rg cr oai', 'important'), { gs: 'minor' }), L('Немає англомовної анотації.', 'No English abstract.'),
					L('Додайте анотацію англійською мовою.', 'Add an abstract in English.')));
			}
			var maxLen = Math.max.apply(null, absLoc.map(function (l) { return abstracts[l]; }));
			if (maxLen < 500) {
				out.push(issue('a-short-abstract', S(ALL, 'minor'), L('Анотація коротка (' + maxLen + ' знаків).', 'Short abstract (' + maxLen + ' characters).'),
					L('Розширте анотацію.', 'Expand the abstract.')));
			}
		}
		if (!(a.titleLocales || []).some(isEnglish) && !isEnglish(a.primaryLocale)) {
			out.push(issue('a-no-en-title', S(ALL, 'minor'), L('Немає англійської назви статті.', 'No English title.'), L('Додайте переклад назви англійською мовою.', 'Add an English translation of the title.')));
		}
		if (!keys(a.keywords).length) {
			out.push(issue('a-no-keywords', S('gs cr oai', 'minor'), L('Не вказано ключових слів.', 'No keywords.'), L('Додайте ключові слова, зокрема англійською.', 'Add keywords, including English ones.')));
		} else if (!keys(a.keywords).some(isEnglish) && !isEnglish(a.primaryLocale)) {
			out.push(issue('a-no-en-keywords', S('cr oai', 'minor'), L('Немає англомовних ключових слів.', 'No English keywords.'), L('Додайте ключові слова англійською.', 'Add keywords in English.')));
		}
		if (!a.referencesCount) {
			out.push(issue('a-no-refs', S('rg cr', 'important'), L('Не заповнено поле «Посилання» (список літератури).', 'The References field is empty.'),
				L('Внесіть список використаних джерел: без нього Crossref не матиме посилань, а цитування не будуть враховані.', 'Enter the reference list: without it Crossref has no references and citations are not counted.')));
		}

		if (!authors.length) {
			out.push(issue('a-no-authors', S(ALL, 'critical'), L('Не вказано авторів.', 'No authors.'), L('Додайте авторів на вкладці «Публікація → Автори».', 'Add authors on the Publication → Contributors tab.')));
		} else {
			var noOrcid = authors.filter(function (x) { return !x.orcid; }).length;
			var noAff = authors.filter(function (x) { return !(x.affiliations || []).length; }).length;
			var noRor = 0;
			authors.forEach(function (x) { (x.affiliations || []).forEach(function (af) { if (!af.ror) { noRor++; } }); });
			var noEn = isEnglish(a.primaryLocale) ? 0 : authors.filter(function (x) { return !hasEnglishName(x); }).length;
			if (noOrcid) {
				out.push(issue('a-no-orcid', M(S('rg cr', 'important'), { oai: 'minor' }),
					L(noOrcid + ' з ' + authors.length + ' ' + P(authors.length, ['автора', 'авторів', 'авторів'], []) + ' без ORCID.',
						noOrcid + ' of ' + authors.length + ' ' + P(authors.length, [], ['author', 'authors']) + ' without ORCID.'),
					L('Додайте ORCID: ідентифікатор однозначно пов\'язує статтю з профілями авторів.', 'Add ORCID iDs: they unambiguously link the article to author profiles.')));
			}
			if (noAff) {
				out.push(issue('a-no-aff', M(S('rg cr', 'important'), S('gs oai', 'minor')),
					noAff + ' ' + P(noAff, ['автор', 'автори', 'авторів'], ['author', 'authors']) + L(' без афіліації.', ' without affiliation.'),
					L('Вкажіть місце роботи кожного автора.', 'Enter the affiliation of every author.')));
			}
			// ROR, назва якого в реєстрі не відповідає назві установи, введеній для автора.
			var badRor = [];
			authors.forEach(function (x) {
				(x.affiliations || []).forEach(function (af) {
					var own = keys(af.names).map(function (l) { return af.names[l]; });
					var reg = keys(af.rorNames || {}).map(function (l) { return af.rorNames[l]; });
					if (af.ror && own.length && reg.length && !own.some(function (n) { return IR.orgMatches(n, reg); })) {
						badRor.push(x.name + ': ' + own[0] + ' ≠ ' + reg[0]);
					}
				});
			});
			if (badRor.length) {
				out.push(issue('a-ror-mismatch', S('rg cr', 'important'),
					L('ROR не відповідає назві установи: ', 'The ROR ID does not match the organisation name: ') + badRor.join('; '),
					L('Поверніть цей запис в «Історії змін» або видаліть ROR у відомостях про автора.', 'Restore this save in the change history or remove the ROR ID from the contributor details.')));
			}
			if (noRor) {
				out.push(issue('a-no-ror', S('rg cr', 'minor'),
					noRor + ' ' + P(noRor, ['афіліація', 'афіліації', 'афіліацій'], ['affiliation', 'affiliations']) + L(' без ідентифікатора ROR.', ' without a ROR ID.'),
					L('Оберіть установу з довідника ROR.', 'Select the organisation from the ROR registry.')));
			}
			if (noEn) {
				out.push(issue('a-no-en-name', M({ cr: 'important' }, S('gs rg oai', 'minor')),
					noEn + ' ' + P(noEn, ['автор', 'автори', 'авторів'], ['author', 'authors']) + L(' без англомовного написання імені.', ' without an English spelling of the name.'),
					L('Заповніть ім\'я та прізвище в англомовній версії полів.', 'Fill in the given and family name in the English version of the fields.')));
			}
		}
		if (!a.licenseUrl && !j.licenseUrl) {
			out.push(issue('a-no-license', M({ oai: 'important' }, { cr: 'minor' }), L('Не вказано ліцензію.', 'No licence.'), L('Вкажіть ліцензію статті або журналу.', 'Set the article or journal licence.')));
		} else if (!a.licenseUrl) {
			out.push(issue('a-license-default', M({ oai: 'minor' }, { cr: 'minor' }), L('Ліцензію статті не збережено в її метаданих.', 'The licence is not stored in the article metadata.'),
				L('Перенесіть типову ліцензію журналу в метадані статті.', 'Copy the default journal licence into the article metadata.')));
		}
		if (!a.pages) {
			out.push(issue('a-no-pages', S('gs cr', 'minor'), L('Не вказано сторінки.', 'No page numbers.'), L('Заповніть поле «Сторінки» на вкладці «Публікація → Випуск».', 'Fill in Pages on the Publication → Issue tab.')));
		}

		// Crossref
		if (a.doi && Object.prototype.hasOwnProperty.call(state.crossref, a.doi.toLowerCase())) {
			var cr = state.crossref[a.doi.toLowerCase()];
			if (cr === null) {
				out.push(issue('c-missing', S('rg cr', 'critical'), L('DOI не знайдено в Crossref.', 'The DOI is not found in Crossref.'),
					L('Перевірте, чи DOI зареєстровано і чи правильний префікс.', 'Check that the DOI is registered and the prefix is correct.')));
			} else if (cr && !cr.error) {
				if (absLoc.length && !cr.abstract) { out.push(issue('c-no-abstract', S('rg cr', 'important'), L('Анотація не потрапила до Crossref.', 'The abstract is missing in Crossref.'), redeposit)); }
				if (a.referencesCount && !cr.refs) {
					out.push(issue('c-no-refs', S('rg cr', 'important'), L('Список літератури не передано до Crossref.', 'References are missing in Crossref.'),
						j.plugins && j.plugins.crossrefReferenceLinking ? redeposit : L('Увімкніть плагін Crossref Reference Linking і депонуйте DOI повторно.', 'Enable the Crossref Reference Linking plugin and deposit the DOI again.')));
				}
				var ojsOrcid = authors.filter(function (x) { return x.orcid; }).length;
				if (ojsOrcid > cr.orcid) { out.push(issue('c-orcid', S('rg cr', 'minor'), L('ORCID є в OJS, але не в Crossref.', 'ORCID iDs are in OJS but not in Crossref.'), redeposit)); }
				if (authors.some(function (x) { return (x.affiliations || []).length; }) && !cr.aff) {
					out.push(issue('c-aff', S('rg cr', 'minor'), L('Афіліації не передано до Crossref.', 'Affiliations are missing in Crossref.'), redeposit));
				}
				if (!cr.license) { out.push(issue('c-license', S('rg cr', 'minor'), L('У записі Crossref немає ліцензії.', 'The Crossref record has no licence.'), redeposit)); }
				if (!cr.link) {
					out.push(issue('c-link', S('rg cr', 'minor'), L('У записі Crossref немає посилання на повний текст.', 'The Crossref record has no full-text link.'),
						L('Депонуйте DOI повторно після публікації PDF.', 'Deposit the DOI again after publishing the PDF.')));
				}
			}
		}

		// Сторінка статті
		var pg = state.pages[a.id];
		if (pg) {
			if (pg.error || pg.status !== 200) {
				out.push(issue('p-status', S('gs rg', 'critical'), L('Сторінка статті недоступна', 'The article page is not available') + (pg.status ? ' (' + L('код', 'code') + ' ' + pg.status + ')' : '') + '.',
					L('Перевірте, чи відкривається сторінка без входу і чи не блокує її захист від роботів на хостингу.', 'Check that the page opens without login and is not blocked by bot protection on the hosting.')));
			} else {
				if (pg.noindex) {
					out.push(issue('p-noindex', S('gs rg', 'critical'), L('Сторінку заборонено індексувати (noindex).', 'The page is marked noindex.'),
						L('Приберіть noindex або X-Robots-Tag.', 'Remove noindex or the X-Robots-Tag header.')));
				}
				if (!pg.title || !pg.author) {
					out.push(issue('p-meta', { gs: 'critical', rg: 'important' }, L('На сторінці немає міток citation_*.', 'The page has no citation_* tags.'),
						L('Увімкніть «Плагін індексування в Google Академії».', 'Enable the Google Scholar Indexing plugin.')));
				} else {
					if (hasPdf && !pg.pdf) {
						out.push(issue('p-pdf', { gs: 'important', rg: 'minor' }, L('На сторінці немає мітки citation_pdf_url.', 'The page has no citation_pdf_url tag.'),
							L('Перевірте, чи PDF-гранка опублікована й доступна без входу.', 'Check that the PDF galley is published and opens without login.')));
					}
					if (a.doi && !pg.doi) {
						out.push(issue('p-doi', { gs: 'minor' }, L('На сторінці немає мітки citation_doi.', 'The page has no citation_doi tag.'), L('Перевірте відображення DOI.', 'Check the DOI display.')));
					}
				}
			}
		}
		if (state.robots && state.robots.groups && a.url && !robotsAllows(pathOf(a.url), 'googlebot-scholar googlebot researchgate')) {
			out.push(issue('p-robots', S('gs rg', 'critical'), L('robots.txt забороняє обхід сторінки статті.', 'robots.txt blocks the article page.'), L('Змініть правила robots.txt.', 'Change the robots.txt rules.')));
		}

		// PDF-файл
		var f = state.pdf[a.id];
		if (f) {
			if (f.error) {
				out.push(issue('f-error', { gs: 'minor' }, L('Не вдалося прочитати PDF-файл.', 'The PDF could not be read.'), String(f.error)));
			} else {
				if (f.chars < 500 * Math.min(f.pages, 3)) {
					out.push(issue('f-notext', { gs: 'critical', rg: 'important' }, L('PDF не містить текстового шару (скановані сторінки).', 'The PDF has no text layer (scanned pages).'),
						L('Замініть файл на PDF, створений із текстового документа, або розпізнайте текст: інакше Google Scholar не прочитає статтю.',
							'Replace it with a PDF created from a text document, or run OCR: otherwise Google Scholar cannot read the article.')));
				}
				if (f.size > 5 * 1048576) {
					out.push(issue('f-size', { gs: 'important' }, L('PDF-файл завеликий (' + fmtSize(f.size) + ').', 'The PDF is too large (' + fmtSize(f.size) + ').'),
						L('Google Scholar може не обробити файл понад 5 МБ; стисніть зображення у файлі.', 'Google Scholar may skip files over 5 MB; compress the images in the file.')));
				}
				if (f.pages > 60) {
					out.push(issue('f-pages', { gs: 'important' }, L('PDF має ' + f.pages + ' сторінок.', 'The PDF has ' + f.pages + ' pages.'),
						L('Ймовірно, це весь випуск: кожна стаття має бути окремим PDF-файлом.', 'This is probably a whole issue: each article should be a separate PDF.')));
				}
				if (f.titleHit != null && f.titleHit < 0.5 && f.chars >= 500) {
					out.push(issue('f-title', { gs: 'important' }, L('Назви статті не знайдено на першій сторінці PDF.', 'The article title is not on the first PDF page.'),
						L('Google Scholar очікує назву й авторів на першій сторінці файлу.', 'Google Scholar expects the title and authors on the first page.')));
				}
			}
		}
		return out;
	}

	function scoreFor(issues, sysId) {
		var seen = {}, s = 100;
		issues.forEach(function (i) {
			if (!i.sys[sysId] || seen[i.id]) { return; }
			seen[i.id] = true;
			s -= SEV[i.sys[sysId]].weight;
		});
		return Math.max(0, s);
	}
	function scores(a, issues) {
		var o = {};
		SYSTEMS.forEach(function (s) { o[s.id] = a.loadError ? 0 : scoreFor(issues, s.id); });
		o.min = Math.min.apply(null, SYSTEMS.map(function (s) { return o[s.id]; }));
		return o;
	}
	function levelCls(sc) { return sc >= READY ? 'ok' : (sc >= 60 ? 'mid' : 'bad'); }
	function levelLabel(sc) { return sc >= READY ? L('Готова', 'Ready') : (sc >= 60 ? L('Потребує доопрацювання', 'Needs work') : L('Проблемна', 'Problematic')); }
	function sortIssues(list) { return list.slice().sort(function (x, y) { return SEV[x.sev].order - SEV[y.sev].order; }); }

	// ------------------------------------------------------------------
	// Перевірки: Crossref, сторінки, PDF
	// ------------------------------------------------------------------

	var CR_SELECT = 'select=DOI,abstract,author,license,link,references-count';
	function crUrl(path, params) {
		var qs = params.slice();
		if (cfg.mailto) { qs.push('mailto=' + encodeURIComponent(cfg.mailto)); }
		return 'https://api.crossref.org/' + path + (qs.length ? '?' + qs.join('&') : '');
	}
	function crSummary(it) {
		var au = it.author || [];
		return {
			abstract: !!it.abstract, refs: it['references-count'] || 0,
			orcid: au.filter(function (x) { return !!x.ORCID; }).length,
			aff: au.some(function (x) { return (x.affiliation || []).length > 0; }),
			license: (it.license || []).length > 0, link: (it.link || []).length > 0
		};
	}
	function getJson(url) {
		return fetch(url, { credentials: 'omit' }).then(function (r) {
			if (r.status === 404) { return { notFound: true }; }
			if (!r.ok) { throw new Error('HTTP ' + r.status); }
			return r.json();
		});
	}
	async function runCrossref() {
		var dois = [];
		state.data.articles.forEach(function (a) { if (a.doi && dois.indexOf(a.doi.toLowerCase()) === -1) { dois.push(a.doi.toLowerCase()); } });
		var res = {}, missing = [], size = 20;
		for (var i = 0; i < dois.length; i += size) {
			var chunk = dois.slice(i, i + size), batch = chunk.filter(function (d) { return d.indexOf(',') === -1; });
			progress('Crossref: ' + Math.min(i + size, dois.length) + L(' з ', ' of ') + dois.length);
			try {
				var j = await getJson(crUrl('works', ['filter=' + batch.map(function (d) { return 'doi:' + encodeURIComponent(d); }).join(','), 'rows=' + size, CR_SELECT]));
				((j.message && j.message.items) || []).forEach(function (it) { res[String(it.DOI).toLowerCase()] = crSummary(it); });
			} catch (e) {
				batch.forEach(function (d) { res[d] = { error: String(e) }; });
			}
			chunk.forEach(function (d) { if (!(d in res)) { missing.push(d); } });
			await sleep(300);
		}
		for (var k = 0; k < missing.length; k++) {
			progress(L('Crossref, уточнення: ', 'Crossref, follow-up: ') + (k + 1) + L(' з ', ' of ') + missing.length);
			try {
				var one = await getJson(crUrl('works/' + encodeURIComponent(missing[k]), []));
				res[missing[k]] = one.notFound ? null : crSummary(one.message || {});
			} catch (e) { res[missing[k]] = { error: String(e) }; }
			await sleep(200);
		}
		state.crossref = res;
		state.crossrefCheckedAt = new Date().toISOString();
		saveCache();
	}

	function checkPage(a) {
		return fetch(a.url, { credentials: 'omit', cache: 'no-store' }).then(function (res) {
			var xr = (res.headers.get('x-robots-tag') || '').toLowerCase();
			return res.text().then(function (html) {
				var doc = new DOMParser().parseFromString(html, 'text/html');
				var m = function (n) { return !!doc.querySelector('meta[name="' + n + '"]'); };
				var rm = doc.querySelector('meta[name="robots"]');
				var rc = rm ? (rm.getAttribute('content') || '').toLowerCase() : '';
				return { status: res.status, title: m('citation_title'), author: m('citation_author'), pdf: m('citation_pdf_url'), doi: m('citation_doi'),
					noindex: xr.indexOf('noindex') !== -1 || rc.indexOf('noindex') !== -1 };
			});
		}).catch(function (e) { return { error: String(e) }; });
	}

	async function pool(list, n, fn) {
		var index = 0;
		async function worker() {
			while (index < list.length) { await fn(list[index++]); }
		}
		var ws = [];
		for (var w = 0; w < n; w++) { ws.push(worker()); }
		await Promise.all(ws);
	}

	async function runPages() {
		var list = state.data.articles.filter(function (a) { return a.url && !a.loadError; }), res = {}, done = 0;
		await pool(list, 3, async function (a) {
			res[a.id] = await checkPage(a);
			done++;
			progress(L('Сторінки статей: ', 'Article pages: ') + done + L(' з ', ' of ') + list.length);
			await sleep(150);
		});
		state.pages = res;
		state.pagesCheckedAt = new Date().toISOString();
		saveCache();
	}

	function pdfGalley(a) {
		return (a.galleys || []).filter(function (g) { return g.pdfUrl; })[0] || null;
	}

	async function analyzePdf(a) {
		var g = pdfGalley(a);
		if (!g) { return; }
		try {
			var pdf = await IR.readPdf(cfg, g.pdfUrl);
			state.parsed[a.id] = IR.parseArticle(pdf, a);
			state.pdf[a.id] = { size: pdf.size, pages: pdf.pages, chars: pdf.chars, titleHit: IR.titleOnFirstPage(pdf.firstPage, a.titles) };
		} catch (e) {
			state.pdf[a.id] = { error: String(e && e.message || e) };
		}
	}

	async function runPdf(onlyIds) {
		var list = state.data.articles.filter(function (a) { return !a.loadError && pdfGalley(a) && (!onlyIds || onlyIds[a.id]); });
		var done = 0;
		await pool(list, 2, async function (a) {
			await analyzePdf(a);
			done++;
			progress(L('PDF-файли: ', 'PDF files: ') + done + L(' з ', ' of ') + list.length);
		});
		state.pdfCheckedAt = new Date().toISOString();
		saveCache();
	}

	// ------------------------------------------------------------------
	// Пропозиції доповнень
	// ------------------------------------------------------------------

	/** Мови метаданих журналу, для яких плагін бере дані з PDF: { en: 'en', uk: 'uk' } */
	function pdfLocales(j) {
		var map = {};
		(j.metadataLocales || []).forEach(function (loc) {
			var lang = String(loc).slice(0, 2).toLowerCase();
			if ((lang === 'en' || lang === 'uk') && !map[lang]) { map[lang] = loc; }
		});
		return map;
	}

	function hasLocale(obj, lang) { return keys(obj).some(function (l) { return String(l).slice(0, 2).toLowerCase() === lang; }); }

	function needsPdf(a, j) {
		var locs = pdfLocales(j), need = !a.referencesCount || !a.pages || (a.authors || []).some(function (x) {
			return !x.orcid || !x.hasEmail || !(x.affiliations || []).length || (!isEnglish(a.primaryLocale) && !hasEnglishName(x));
		});
		keys(locs).forEach(function (lang) {
			if (!hasLocale(a.abstracts, lang) || !hasLocale(a.keywords, lang) || !(a.titleLocales || []).some(function (l) { return l.slice(0, 2) === lang; })) { need = true; }
		});
		return need;
	}

	/**
	 * Пропозиція. Підписи формуються під час відображення (функція propText),
	 * щоб перемикання мови інтерфейсу змінювало й їх.
	 */
	function prop(type, source, confidence, data) {
		var p = { type: type, source: source, confidence: confidence, checked: confidence !== 'low' };
		keys(data).forEach(function (k) { p[k] = data[k]; });
		return p;
	}

	function langName(lang) {
		return lang === 'en' ? L('англійською', 'in English') : L('українською', 'in Ukrainian');
	}

	function propText(p) {
		var label = {
			licenseUrl: L('Ліцензія статті', 'Article licence'),
			title: L('Назва ', 'Title ') + langName(p.lang),
			abstract: L('Анотація ', 'Abstract ') + langName(p.lang),
			keywords: L('Ключові слова ', 'Keywords ') + langName(p.lang),
			citationsRaw: L('Список літератури (поле «Посилання»)', 'Reference list (References field)'),
			authorOrcid: 'ORCID: ' + p.authorName,
			authorName: L('Ім\'я англійською: ', 'Name in English: ') + p.authorName,
			affiliationRor: L('ROR для ', 'ROR for ') + q(p.affiliationName),
			pages: L('Сторінки', 'Pages'),
			authorEmail: 'Email: ' + p.authorName,
			authorAffiliation: L('Місце роботи: ', 'Affiliation: ') + p.authorName
		}[p.type] || p.type;
		var source = {
			journal: L('налаштування журналу', 'journal settings'),
			pdf: L('PDF-файл', 'PDF file'),
			pdfSection: L('PDF-файл, розділ ', 'PDF file, section ') + q(p.heading || ''),
			crossrefRefs: L('запис статті в Crossref', 'the article record in Crossref'),
			pdfOrcid: L('PDF-файл, підтверджено профілем ORCID', 'PDF file, confirmed by the ORCID record'),
			orcid: L('профіль ORCID', 'ORCID record'),
			ror: L('реєстр ROR', 'ROR registry')
		}[p.source] || p.source;
		var note = '';
		if (p.note === 'caps') {
			note = L('у PDF назву набрано великими літерами; регістр відновлено за основним текстом статті — перевірте власні назви й абревіатури',
				'the PDF title is in capitals; letter case was restored from the article text — check proper names and abbreviations');
		} else if (p.type === 'citationsRaw') {
			note = p.count + ' ' + P(p.count, ['джерело', 'джерела', 'джерел'], ['reference', 'references']) + L('; кожне джерело — окремий рядок', '; one reference per line');
		} else if (p.type === 'affiliationRor') {
			note = p.rorName || '';
		}
		return { label: label, source: source, note: note };
	}

	var crRefCache = {};

	/** Список літератури з запису Crossref (неструктурований текст або складений із полів запису). */
	function crossrefReferences(doi) {
		var key = String(doi).toLowerCase();
		if (!crRefCache[key]) {
			crRefCache[key] = getJson(crUrl('works/' + encodeURIComponent(key), [])).then(function (j) {
				var refs = (j && j.message && j.message.reference) || [];
				return refs.map(function (r) {
					if (r.unstructured) { return String(r.unstructured).replace(/\s+/g, ' ').trim(); }
					var parts = [r.author, r.year ? '(' + r.year + ')' : '', r['article-title'] || r['volume-title'], r['journal-title'] || r['series-title'],
						r.volume, r['first-page'], r.DOI ? 'https://doi.org/' + r.DOI : ''].filter(Boolean);
					return parts.length >= 3 ? parts.join('. ').replace(/\.\s*\./g, '.') : '';
				}).filter(Boolean);
			}).catch(function () { return null; });
		}
		return crRefCache[key];
	}

	async function proposalsFor(a, j) {
		var list = [], en = j.englishLocale, parsed = state.parsed[a.id];

		if (!a.licenseUrl && j.licenseUrl) {
			list.push(prop('licenseUrl', 'journal', 'high', { value: j.licenseUrl }));
		}
		if (parsed) {
			var locs = pdfLocales(j);
			keys(locs).forEach(function (lang) {
				var loc = locs[lang], got = parsed.langs[lang] || {};
				if (!(a.titleLocales || []).some(function (l) { return l.slice(0, 2) === lang; }) && got.title) {
					list.push(prop('title', 'pdf', got.title.confidence, { lang: lang, locale: loc, value: got.title.text, note: got.title.note || '', editable: true }));
				}
				if (!hasLocale(a.abstracts, lang) && got.abstract) {
					list.push(prop('abstract', 'pdf', 'medium', { lang: lang, locale: loc, value: got.abstract, editable: true }));
				}
				if (!hasLocale(a.keywords, lang) && got.keywords && got.keywords.length) {
					var good = got.keywords.length >= 2 && got.keywords.every(function (k) { return k.split(' ').length <= 10; });
					list.push(prop('keywords', 'pdf', good ? 'medium' : 'low', { lang: lang, locale: loc, value: got.keywords.join('; '), editable: true }));
				}
			});
		}

		// Список літератури: спершу з Crossref (його депонував сам журнал), потім із PDF.
		if (!a.referencesCount) {
			var alts = [];
			var crRefs = a.doi ? await crossrefReferences(a.doi) : null;
			if (crRefs && crRefs.length >= 2) {
				alts.push({ heading: 'Crossref', source: 'crossrefRefs', value: crRefs.join('\n'), count: crRefs.length, rejected: [] });
			}
			((parsed && parsed.references) || []).slice().sort(function (x, y) { return (y.latin ? 1 : 0) - (x.latin ? 1 : 0); }).forEach(function (l) {
				alts.push({ heading: l.heading, source: 'pdfSection', value: l.items.join('\n'), count: l.items.length, rejected: l.rejected || [] });
			});
			if (alts.length) {
				var pick = alts[0];
				var suspicious = pick.source !== 'crossrefRefs' && (pick.count < 3 || pick.value.split('\n').some(function (x) { return x.length > 700; }));
				list.push(prop('citationsRaw', pick.source, pick.source === 'crossrefRefs' ? 'high' : (suspicious ? 'low' : 'medium'), {
					heading: pick.heading, count: pick.count, value: pick.value, rejected: pick.rejected, editable: true, alternatives: alts
				}));
			}
		}

		if (!a.pages && parsed && parsed.pages) {
			list.push(prop('pages', 'pdf', parsed.pages.confidence, { value: parsed.pages.value, editable: true }));
		}

		var locsAll = pdfLocales(j);
		for (var i = 0; i < (a.authors || []).length; i++) {
			var au = a.authors[i];
			var blocks = (parsed && parsed.authors && parsed.authors[au.id]) || [];
			var latinBlock = blocks.filter(function (b) { return b.latin; })[0] || null;
			var orcid = au.orcid ? IR.orcidBare(au.orcid) : '';

			// ORCID, надрукований у статті біля імені автора; підтверджується профілем ORCID.
			if (!orcid && parsed) {
				var printed = (blocks.filter(function (b) { return b.orcid; })[0] || {}).orcid
					|| ((parsed.orcids || []).filter(function (o) { return o.authorId === au.id; })[0] || {}).orcid;
				if (printed) {
					var person = await IR.orcidPerson(printed);
					var fams = IR.familyNames(au), tokens = [];
					(person ? [person.family, person.given].concat(person.other || []) : []).forEach(function (n) {
						String(n || '').split(/[\s,.;]+/).forEach(function (t) { if (t.length > 1) { tokens.push(t); } });
					});
					if (fams.some(function (f) { return tokens.some(function (t) { return IR.sameFamilyName(f, t); }); })) {
						orcid = printed;
						list.push(prop('authorOrcid', 'pdfOrcid', 'medium', { authorId: au.id, authorName: au.name, value: 'https://orcid.org/' + printed }));
					}
				}
			}

			// Ім'я англійською: лише з профілю ORCID або з англомовної частини статті.
			if (en && !isEnglish(a.primaryLocale) && !hasEnglishName(au)) {
				var given = '', family = '', src = '', conf = 'medium';
				if (orcid) {
					var po = await IR.orcidPerson(orcid);
					if (po && po.given && po.family && IR.latinRatio(po.given + po.family) > 0.95 && !/[.,;]/.test(po.given + po.family)) {
						given = po.given; family = po.family; src = 'orcid'; conf = 'high';
					}
				}
				if (!family && latinBlock && latinBlock.family) {
					given = latinBlock.given; family = latinBlock.family; src = 'pdf'; conf = 'medium';
				}
				if (family) {
					list.push(prop('authorName', src, conf, { authorId: au.id, authorName: au.name, locale: en, givenName: given, familyName: family, editable: true }));
				}
			}

			// Email, надрукований у статті.
			if (!au.hasEmail) {
				var mail = (blocks.filter(function (b) { return b.email; })[0] || {}).email;
				if (mail) {
					list.push(prop('authorEmail', 'pdf', 'medium', { authorId: au.id, authorName: au.name, value: mail, editable: true }));
				}
			}

			// Місце роботи, надруковане в статті (лише якщо в OJS афіліації немає).
			if (!(au.affiliations || []).length) {
				var names = {};
				blocks.forEach(function (b) {
					if (!b.affiliation) { return; }
					var lang = b.affiliationLatin ? 'en' : 'uk';
					if (locsAll[lang] && !names[locsAll[lang]]) { names[locsAll[lang]] = b.affiliation; }
				});
				if (keys(names).length) {
					list.push(prop('authorAffiliation', 'pdf', 'medium', { authorId: au.id, authorName: au.name, names: names, editable: true }));
				}
			}

			// ROR (лише якщо в OJS завантажено локальний реєстр ROR)
			for (var k = 0; j.rorRegistrySize && k < (au.affiliations || []).length; k++) {
				var af = au.affiliations[k];
				if (af.ror) { continue; }
				var ror = await IR.rorMatch(firstEnglish(af.names) || af.name);
				if (ror && ror.id) {
					list.push(prop('affiliationRor', 'ror', ror.score >= 0.95 ? 'high' : 'medium',
						{ authorId: au.id, affiliationId: af.id, affiliationName: af.name, value: ror.id, rorName: ror.name }));
				}
			}
		}
		return list;
	}

	function firstValue(o) { var k = keys(o); return k.length ? o[k[0]] : ''; }
	function firstEnglish(o) { var k = keys(o).filter(isEnglish); return k.length ? o[k[0]] : ''; }

	async function runProposals(onlyIds) {
		var j = state.data.journal, arts = state.data.articles.filter(function (a) { return !a.loadError && (!onlyIds || onlyIds.indexOf(a.id) !== -1); });
		var need = {};
		arts.forEach(function (a) { if (pdfGalley(a) && needsPdf(a, j) && !state.parsed[a.id]) { need[a.id] = true; } });
		if (keys(need).length) { await runPdf(need); }
		if (!onlyIds) { state.proposals = {}; }
		for (var i = 0; i < arts.length; i++) {
			delete state.proposals[arts[i].id];
			progress(L('Доповнення: ', 'Additions: ') + (i + 1) + L(' з ', ' of ') + arts.length + L(' (PDF, ORCID, ROR)', ' (PDF, ORCID, ROR)'));
			var list = await proposalsFor(arts[i], j);
			if (list.length) { state.proposals[arts[i].id] = list; }
		}
		state.proposalsReady = true;
		openProposals();
	}

	/** Показує в списку статей лише ті, де знайдено дані, і розгортає їх. */
	function openProposals() {
		state.filter = 'proposals';
		keys(state.proposals).forEach(function (id) { state.open[id] = true; });
	}

	function scrollToApply() {
		var el = document.getElementById('ir-apply');
		if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
		try { if (window.frameElement) { window.frameElement.scrollIntoView({ behavior: 'smooth', block: 'start' }); } } catch (e) { /* інший домен */ }
	}

	function buildOps(a) {
		return (state.proposals[a.id] || []).filter(function (p) { return p.checked; }).map(function (p) {
			var label = propText(p).label;
			switch (p.type) {
				case 'title': case 'abstract': return { type: p.type, locale: p.locale, value: p.value, label: label };
				case 'keywords': return { type: 'keywords', locale: p.locale, values: String(p.value).split(/\s*[;,]\s*/).filter(Boolean), label: label };
				case 'citationsRaw': return { type: 'citationsRaw', value: p.value, label: label };
				case 'licenseUrl': return { type: 'licenseUrl', value: p.value, label: label };
				case 'authorName': return { type: 'authorName', authorId: p.authorId, locale: p.locale, givenName: p.givenName, familyName: p.familyName, label: label };
				case 'authorOrcid': return { type: 'authorOrcid', authorId: p.authorId, orcid: p.value, label: label };
				case 'affiliationRor': return { type: 'affiliationRor', authorId: p.authorId, affiliationId: p.affiliationId, ror: p.value, label: label };
				case 'pages': return { type: 'pages', value: p.value, label: label };
				case 'authorEmail': return { type: 'authorEmail', authorId: p.authorId, email: p.value, label: label };
				case 'authorAffiliation': return { type: 'authorAffiliation', authorId: p.authorId, names: p.names, label: label };
			}
			return null;
		}).filter(Boolean);
	}

	function depositSummary(counts) {
		var parts = [];
		if (counts.queued) {
			parts.push(L('До Crossref надіслано оновлення ' + counts.queued + ' ' + P(counts.queued, ['статті', 'статей', 'статей'], []) + ' (статус DOI «Подано»).',
				'Updates of ' + counts.queued + ' ' + P(counts.queued, [], ['article', 'articles']) + ' sent to Crossref (DOI status “Submitted”).'));
		}
		if (counts.unregistered) {
			parts.push(L(counts.unregistered + ' ' + P(counts.unregistered, ['стаття має', 'статті мають', 'статей мають'], []) + ' незареєстрований DOI: його не надіслано, бо первинна реєстрація платна. Зареєструйте такі DOI у розділі «DOI».',
				counts.unregistered + ' ' + P(counts.unregistered, [], ['article has', 'articles have']) + ' an unregistered DOI: it was not sent, because the first registration is paid. Register such DOIs in the DOIs section.'));
		}
		if (counts.stale) {
			parts.push(L('DOI ' + counts.stale + ' ' + P(counts.stale, ['статті', 'статей', 'статей'], []) + ' позначено «Потребує синхронізації»: надішліть їх у розділі «DOI».',
				'DOIs of ' + counts.stale + ' ' + P(counts.stale, [], ['article', 'articles']) + ' are marked “Needs Sync”: deposit them in the DOIs section.'));
		}
		return parts.join(' ');
	}

	async function applyFor(ids) {
		var okCount = 0, skipCount = 0, errors = 0, dep = { queued: 0, unregistered: 0, stale: 0 };
		for (var i = 0; i < ids.length; i++) {
			var a = state.data.articles.filter(function (x) { return x.id === ids[i]; })[0];
			var ops = a ? buildOps(a) : [];
			if (!ops.length) { continue; }
			progress(L('Запис змін: ', 'Saving changes: ') + (i + 1) + L(' з ', ' of ') + ids.length);
			try {
				var r = await postJson(cfg.applyUrl, { submissionId: a.id, ops: ops, deposit: state.deposit, source: 'indexingReadiness' });
				state.results[a.id] = r;
				okCount += (r.applied || []).length;
				skipCount += (r.skipped || []).length;
				if ((r.applied || []).length) {
					delete state.proposals[a.id];
					if (r.deposit === 'queued') { dep.queued++; }
					else if (r.deposit === 'unregistered') { dep.unregistered++; }
					else if (a.doi) { dep.stale++; }
				}
			} catch (e) {
				state.results[a.id] = { error: e.message };
				errors++;
			}
		}
		await reloadData();
		await loadHistory().catch(function () { state.history = null; });
		state.notice = L('Записано значень: ', 'Values saved: ') + okCount
			+ (skipCount ? L('; пропущено: ', '; skipped: ') + skipCount : '')
			+ (errors ? L('; помилок: ', '; errors: ') + errors : '') + '. ' + depositSummary(dep);
	}

	async function loadHistory() {
		var r = await fetch(cfg.historyUrl, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
		state.history = (await r.json()).entries || [];
	}

	async function rollback(id) {
		var r = await postJson(cfg.rollbackUrl, { entryId: id, deposit: state.deposit });
		var dep = { queued: r.deposit === 'queued' ? 1 : 0, unregistered: r.deposit === 'unregistered' ? 1 : 0, stale: 0 };
		state.notice = L('Повернуто полів: ', 'Fields restored: ') + (r.restored || []).length
			+ ((r.kept || []).length ? L('; залишено без змін (поле пізніше змінено вручну): ', '; left unchanged (the field was edited manually later): ') + r.kept.length : '') + '. ' + depositSummary(dep);
		await reloadData();
		await loadHistory();
	}

	function reloadData() {
		return fetch(cfg.dataUrl, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
			.then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
			.then(function (d) { state.data = d; });
	}

	// ------------------------------------------------------------------
	// Запуск дій
	// ------------------------------------------------------------------

	function progress(text) {
		state.progress = text;
		var el = app.querySelector('.rg-progress-text');
		if (el) { el.textContent = text; } else { render(); }
	}

	async function run(kind, arg) {
		if (state.running) { return; }
		state.running = kind;
		state.notice = '';
		render();
		try {
			if (kind === 'all' || kind === 'crossref') { await runCrossref(); }
			if (kind === 'all' || kind === 'pages') { await runPages(); await checkOai(); }
			if (kind === 'all' || kind === 'pdf') { await runPdf(); }
			if (kind === 'proposals') { await runProposals(); }
			if (kind === 'batch-find') { await runBatch(arg, false); }
			if (kind === 'batch-auto') { await runBatch(arg, true); }
			if (kind === 'apply') { await applyFor(arg); }
			if (kind === 'history') { await loadHistory(); state.showHistory = true; }
			if (kind === 'rollback') { await rollback(arg); }
		} catch (e) {
			state.notice = L('Помилка: ', 'Error: ') + (e.message || e);
		} finally {
			state.running = '';
			state.progress = '';
			state.confirmAll = false;
			state.confirmBatch = false;
			render();
		}
	}

	// ------------------------------------------------------------------
	// CSV
	// ------------------------------------------------------------------

	function exportCsv(rows) {
		var head = ['ID', L('Назва', 'Title'), L('Випуск', 'Issue'), 'DOI'].concat(SYSTEMS.map(function (s) { return s.name; }), [L('Проблеми та рекомендації', 'Problems and recommendations'), 'URL']);
		var lines = [head];
		rows.forEach(function (r) {
			lines.push([r.a.id, r.a.title, r.a.issue, r.a.doi].concat(SYSTEMS.map(function (s) { return r.score[s.id]; }), [
				sortIssues(r.issues).map(function (i) { return '[' + SEV[i.sev].label + '; ' + sysList(i.sys) + '] ' + i.text + ' → ' + i.fix; }).join(' | '),
				r.a.url
			]));
		});
		var csv = '﻿' + lines.map(function (l) { return l.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(';'); }).join('\r\n');
		var link = document.createElement('a');
		link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
		link.download = 'indexing-readiness-' + new Date().toISOString().slice(0, 10) + '.csv';
		document.body.appendChild(link);
		link.click();
		setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
	}

	// ------------------------------------------------------------------
	// Відображення
	// ------------------------------------------------------------------

	function sysList(sys) {
		return SYSTEMS.filter(function (s) { return sys[s.id]; }).map(function (s) { return s.short; }).join(', ');
	}
	function sysChips(sys) {
		return '<span class="ir-chips">' + SYSTEMS.filter(function (s) { return sys[s.id]; }).map(function (s) {
			return '<span class="ir-chip ir-chip-' + SEV[sys[s.id]].cls + '" title="' + esc(s.name + ': ' + SEV[sys[s.id]].label) + '">' + s.short + '</span>';
		}).join('') + '</span>';
	}
	function badge(sev) { return '<span class="rg-badge rg-' + SEV[sev].cls + '">' + SEV[sev].label + '</span>'; }

	function issueList(list) {
		return '<ul class="rg-issues">' + sortIssues(list).map(function (i) {
			return '<li>' + badge(i.sev) + ' <strong>' + esc(i.text) + '</strong> ' + sysChips(i.sys)
				+ (i.fix ? '<div class="rg-fix">' + esc(i.fix) + (i.link ? ' <a href="' + esc(i.link) + '" target="_top">' + L('Перейти до налаштувань', 'Open settings') + '</a>' : '') + '</div>' : '')
				+ '</li>';
		}).join('') + '</ul>';
	}

	function confLabel(c) { return { high: L('висока', 'high'), medium: L('середня', 'medium'), low: L('низька', 'low') }[c]; }

	function depositCheckbox(extraCls) {
		return '<label class="ir-check' + (extraCls ? ' ' + extraCls : '') + '"><input type="checkbox" data-deposit="1"' + (state.deposit ? ' checked' : '') + '> '
			+ L('Одразу надіслати оновлення до Crossref', 'Send the update to Crossref right away') + '</label>'
			+ '<div class="rg-muted ir-hint">' + (state.deposit
				? L('Після запису DOI статті отримає статус «Подано», а після підтвердження Crossref — «Зареєстровано». Оновлення метаданих у Crossref безкоштовне. Незареєстровані DOI не надсилаються, бо первинна реєстрація платна.',
					'After saving, the DOI status becomes “Submitted”, then “Registered” once Crossref confirms it. Metadata updates in Crossref are free. Unregistered DOIs are not sent, because the first registration is paid.')
				: L('Після запису DOI отримає статус «Потребує синхронізації»; надіслати його можна пізніше в розділі «DOI» або автоматичним депонуванням.',
					'After saving, the DOI gets the “Needs Sync” status; you can deposit it later in the DOIs section or by automatic deposit.')) + '</div>';
	}

	function proposalBlock(a) {
		var list = state.proposals[a.id] || [], res = state.results[a.id], html = '';
		if (res) {
			if (res.error) {
				html += '<p class="rg-error">' + L('Помилка запису: ', 'Saving failed: ') + esc(res.error) + '</p>';
			} else {
				html += '<p class="rg-okline">' + L('Записано: ', 'Saved: ') + (res.applied || []).length + '.</p>';
				(res.skipped || []).forEach(function (s) { html += '<div class="rg-muted">' + L('Пропущено ', 'Skipped ') + q(s.label) + ': ' + esc(s.reason) + '</div>'; });
			}
		}
		if (!list.length) { return html; }
		html += '<div class="ir-props"><h4>' + L('Знайдено для порожніх полів', 'Found for empty fields') + '</h4>';
		list.forEach(function (p, idx) {
			var t = propText(p), ref = a.id + ':' + idx;
			html += '<div class="ir-prop' + (p.checked ? '' : ' ir-prop-off') + '">'
				+ '<label><input type="checkbox" data-prop="' + ref + '"' + (p.checked ? ' checked' : '') + '> <strong>' + esc(t.label) + '</strong></label>'
				+ ' <span class="rg-muted">' + L('зараз поле порожнє; джерело: ', 'the field is empty now; source: ') + esc(t.source) + L('; надійність: ', '; reliability: ') + confLabel(p.confidence) + '</span>';
			if (t.note) { html += '<div class="rg-muted">' + esc(t.note) + '</div>'; }
			if (p.type === 'authorAffiliation') {
				html += keys(p.names).map(function (loc) {
					return '<div class="ir-name"><span class="ir-loc">' + esc(loc) + '</span><input type="text" data-edit-name="' + ref + ':' + esc(loc) + '" value="' + esc(p.names[loc]) + '"></div>';
				}).join('');
			} else if (p.type === 'authorName') {
				html += '<div class="ir-name"><input type="text" data-edit="' + ref + ':givenName" value="' + esc(p.givenName) + '" placeholder="' + L('Ім\'я', 'Given name') + '">'
					+ '<input type="text" data-edit="' + ref + ':familyName" value="' + esc(p.familyName) + '" placeholder="' + L('Прізвище', 'Family name') + '"></div>';
			} else if (p.editable) {
				if (p.alternatives && p.alternatives.length > 1) {
					html += '<div><select data-alt="' + ref + '">' + p.alternatives.map(function (alt, k) {
						return '<option value="' + k + '"' + (alt.value === p.value ? ' selected' : '') + '>' + esc(alt.source === 'crossrefRefs' ? 'Crossref' : 'PDF: ' + alt.heading) + ' (' + alt.count + ')</option>';
					}).join('') + '</select></div>';
				}
				var rows = p.type === 'citationsRaw' ? 10 : (p.type === 'abstract' ? 6 : 2);
				html += '<textarea rows="' + rows + '" data-edit="' + ref + ':value">' + esc(p.value) + '</textarea>';
				if (p.type === 'citationsRaw' && (p.rejected || []).length) {
					html += '<details class="ir-rejected"><summary>' + L('Відкинуто фрагментів, не схожих на бібліографічний опис: ', 'Fragments rejected as not looking like a reference: ') + p.rejected.length + '</summary><ul>'
						+ p.rejected.map(function (x) { return '<li>' + esc(x.length > 300 ? x.slice(0, 300) + '…' : x) + '</li>'; }).join('') + '</ul></details>';
				}
			} else {
				html += '<div class="ir-value">' + esc(p.value) + '</div>';
			}
			html += '</div>';
		});
		html += '<div class="ir-apply-row">' + depositCheckbox('') + '<button type="button" class="rg-primary" data-apply-one="' + a.id + '"' + (state.running ? ' disabled' : '') + '>'
			+ L('Записати позначене для цієї статті', 'Save the ticked values for this article') + '</button></div></div>';
		return html;
	}

	function buildRows() {
		var j = state.data.journal;
		return state.data.articles.map(function (a) {
			var list = evaluateArticle(a, j);
			return { a: a, issues: list, score: scores(a, list) };
		});
	}

	function filterRows(rows) {
		var qs = state.query.trim().toLowerCase(), sys = state.system;
		return rows.filter(function (r) {
			var sc = sys === 'all' ? r.score.min : r.score[sys];
			var rel = sys === 'all' ? r.issues : r.issues.filter(function (i) { return i.sys[sys]; });
			if (state.filter === 'critical' && !rel.some(function (i) { return (sys === 'all' ? i.sev : i.sys[sys]) === 'critical'; })) { return false; }
			if (state.filter === 'notready' && sc >= READY) { return false; }
			if (state.filter === 'ready' && sc < READY) { return false; }
			if (state.filter === 'proposals' && !(state.proposals[r.a.id] || []).length) { return false; }
			if (state.filter === 'license' && !r.issues.some(function (i) { return /license/.test(i.id); })) { return false; }
			if (state.filter === 'norefs' && r.a.referencesCount) { return false; }
			if (state.filter === 'selected' && !state.selected[r.a.id]) { return false; }
			if (qs && (r.a.title + ' ' + r.a.doi + ' ' + r.a.issue + ' ' + r.a.id).toLowerCase().indexOf(qs) === -1) { return false; }
			return true;
		});
	}

	function topProblems(rows) {
		var map = {}, generic = {
			'a-no-orcid': L('Автори без ORCID.', 'Authors without ORCID.'),
			'a-no-aff': L('Автори без афіліації.', 'Authors without affiliation.'),
			'a-no-ror': L('Афіліації без ROR.', 'Affiliations without ROR.'),
			'a-no-en-name': L('Автори без англомовного написання імені.', 'Authors without an English spelling of the name.'),
			'a-short-abstract': L('Анотація коротша за 500 знаків.', 'Abstract shorter than 500 characters.'),
			'p-status': L('Сторінка статті недоступна.', 'The article page is not available.'),
			'f-size': L('PDF-файл понад 5 МБ.', 'PDF over 5 MB.'),
			'f-pages': L('PDF містить понад 60 сторінок.', 'PDF with more than 60 pages.')
		};
		rows.forEach(function (r) {
			var seen = {};
			r.issues.forEach(function (i) {
				if (seen[i.id]) { return; }
				seen[i.id] = true;
				if (!map[i.id]) { map[i.id] = { sev: i.sev, sys: i.sys, text: generic[i.id] || i.text, fix: i.fix, count: 0 }; }
				map[i.id].count++;
			});
		});
		// Спершу проблеми, що стосуються найбільшої кількості статей; за рівної кількості — серйозніші.
		return keys(map).map(function (k) { return map[k]; }).sort(function (x, y) {
			return (y.count - x.count) || (SEV[x.sev].order - SEV[y.sev].order);
		});
	}

	function card(label, value, cls, title) {
		return '<div class="rg-card' + (cls ? ' rg-card-' + cls : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '><div class="rg-card-value">' + esc(value) + '</div><div class="rg-card-label">' + esc(label) + '</div></div>';
	}

	var CHANGE_LABELS = function () {
		return {
			title: L('Назва', 'Title'), abstract: L('Анотація', 'Abstract'), keywords: L('Ключові слова', 'Keywords'),
			citationsRaw: L('Посилання (список літератури)', 'References'), licenseUrl: L('Ліцензія', 'Licence'), pages: L('Сторінки', 'Pages'),
			authorName: L('Ім\'я англійською', 'Name in English'), authorOrcid: 'ORCID', authorEmail: 'Email',
			authorAffiliation: L('Місце роботи', 'Affiliation'), affiliationRor: 'ROR'
		};
	};

	var HISTORY_PAGE = 10;

	/** Значення зміни для показу в історії. */
	function changeValue(c) {
		var v = c.after;
		if (v == null) { return ''; }
		if (c.type === 'authorName') { return [v.givenName, v.familyName].filter(Boolean).join(' '); }
		if (c.type === 'keywords') { return [].concat(v).join('; '); }
		if (c.type === 'authorAffiliation') { return keys(v).map(function (l) { return l + ': ' + v[l]; }).join('; '); }
		if (c.type === 'citationsRaw') {
			var n = String(v).split('\n').filter(Boolean).length;
			return n + ' ' + P(n, ['джерело', 'джерела', 'джерел'], ['reference', 'references']);
		}
		var text = String(v).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
		return text.length > 160 ? text.slice(0, 160) + '…' : text;
	}

	/** Для кого зміна: ім'я автора з підпису «ORCID: Ім'я» тощо. */
	function changeWho(c) {
		var m = String(c.label || '').match(/:\s*(.+)$/);
		return /^author|^affiliation/.test(c.type) && m ? m[1] : '';
	}

	function historyBlock() {
		var list = state.history || [], labels = CHANGE_LABELS();
		var active = list.filter(function (e) { return !e.rolledBack; });
		var articles = {};
		active.forEach(function (e) { articles[e.submissionId] = true; });
		var html = '<section class="rg-section ir-history"><h3>' + L('Історія змін', 'Change history')
			+ ' <button type="button" class="rg-link" data-history-close="1">' + L('сховати', 'hide') + '</button></h3>';
		html += '<p class="rg-muted">' + L('Тут записано кожне збереження, зроблене плагіном: хто, коли, у якій статті і що саме додано. '
			+ 'Кнопка «Повернути як було» прибирає додані плагіном значення, і ці поля знову стають порожніми. '
			+ 'Значення, які ви змінили вручну після збереження, залишаються без змін.',
			'Every save made by the plugin is recorded here: who, when, in which article and what exactly was added. '
			+ '“Restore previous state” removes the values added by the plugin, and those fields become empty again. '
			+ 'Values you edited manually after the save are left untouched.') + '</p>';
		if (!list.length) { return html + '<p class="rg-muted">' + L('Змін ще не вносили.', 'No changes yet.') + '</p></section>'; }
		html += '<p><strong>' + L('Діючих записів: ', 'Active saves: ') + active.length + '</strong>' + L(' у ', ' in ') + keys(articles).length + ' '
			+ P(keys(articles).length, ['статті', 'статтях', 'статтях'], ['article', 'articles'])
			+ (list.length > active.length ? L('; повернуто: ', '; restored: ') + (list.length - active.length) : '') + '.</p>';

		var shownCount = state.historyLimit || HISTORY_PAGE;
		list.slice(0, shownCount).forEach(function (e) {
			var open = !!(state.historyOpen || {})[e.id];
			html += '<div class="ir-hentry' + (e.rolledBack ? ' ir-hentry-off' : '') + '">'
				+ '<div class="ir-hhead"><div><strong>' + esc(e.title) + '</strong>'
				+ '<div class="rg-muted">' + esc(fmtDate(e.date)) + ' · ' + esc(e.userName) + ' · '
				+ (e.changes || []).length + ' ' + P((e.changes || []).length, ['зміна', 'зміни', 'змін'], ['change', 'changes']) + '</div></div>'
				+ '<div class="ir-hactions">'
				+ (e.rolledBack
					? '<span class="ir-status ir-status-off">' + L('Повернуто ', 'Restored ') + esc(fmtDate(e.rolledBack.date)) + '</span>'
					: '<span class="ir-status">' + L('Діє', 'Active') + '</span>')
				+ ' <button type="button" class="rg-link" data-hopen="' + esc(e.id) + '">' + (open ? L('сховати зміни', 'hide changes') : L('показати зміни', 'show changes')) + '</button>';
			if (!e.rolledBack) {
				html += state.confirmRollback === e.id
					? ' <button type="button" class="rg-danger" data-rollback="' + esc(e.id) + '"' + (state.running ? ' disabled' : '') + '>' + L('Так, повернути', 'Yes, restore') + '</button>'
						+ ' <button type="button" data-rollback-cancel="1">' + L('Ні', 'No') + '</button>'
					: ' <button type="button" data-rollback-ask="' + esc(e.id) + '"' + (state.running ? ' disabled' : '') + '>' + L('Повернути як було', 'Restore previous state') + '</button>';
			}
			html += '</div></div>';
			if (open) {
				html += '<table class="rg-table ir-htable"><tbody>' + (e.changes || []).map(function (c) {
					var who = changeWho(c);
					return '<tr><td>' + esc(labels[c.type] || c.type) + (c.locale ? ' <span class="rg-muted">(' + esc(c.locale) + ')</span>' : '') + '</td>'
						+ '<td>' + esc(who) + '</td>'
						+ '<td><span class="rg-muted">' + L('було: порожньо → стало: ', 'before: empty → after: ') + '</span>' + esc(changeValue(c)) + '</td></tr>';
				}).join('') + '</tbody></table>';
				if (state.confirmRollback === e.id) {
					html += '<p class="rg-muted">' + L('Після повернення ці поля знову стануть порожніми.', 'After restoring, these fields will be empty again.') + '</p>';
				}
			}
			html += '</div>';
		});
		if (list.length > shownCount) {
			html += '<button type="button" class="ir-more" data-history-more="1">' + L('▼ Показати ще ', '▼ Show ') + Math.min(HISTORY_PAGE, list.length - shownCount)
				+ L(' (усього ', ' more (of ') + list.length + ')</button>';
		}
		return html + '</section>';
	}

	function stepsBlock(busy, propCount, propArticles) {
		var dis = busy ? ' disabled' : '';
		var historyCount = state.history ? state.history.filter(function (e) { return !e.rolledBack; }).length : null;
		var step = function (n, title, text, actions, done) {
			return '<div class="ir-step' + (done ? ' ir-step-done' : '') + '"><span class="ir-step-n">' + n + '</span><div class="ir-step-body"><strong>' + title + '</strong>'
				+ '<div class="rg-muted">' + text + '</div><div class="ir-step-actions">' + actions + '</div></div></div>';
		};
		var checked = !!(state.crossrefCheckedAt || state.pagesCheckedAt || state.pdfCheckedAt);
		return '<div class="ir-steps">'
			+ step(1, L('Перевірити статті', 'Check articles'),
				L('Аналізує дані OJS, записи Crossref, сторінки статей і PDF-файли. Нічого не змінює.', 'Analyses OJS data, Crossref records, article pages and PDF files. Changes nothing.'),
				'<button type="button" class="rg-primary" data-run="all"' + dis + '>' + L('Перевірити все', 'Check everything') + '</button>'
				+ '<details class="ir-more-checks"><summary>' + L('окремі перевірки', 'separate checks') + '</summary>'
				+ '<button type="button" data-run="crossref"' + dis + '>Crossref</button> '
				+ '<button type="button" data-run="pages"' + dis + '>' + L('Сторінки й OAI', 'Pages and OAI') + '</button> '
				+ '<button type="button" data-run="pdf"' + dis + '>' + L('PDF-файли', 'PDF files') + '</button></details>', checked)
			+ step(2, L('Знайти відсутні дані', 'Find missing data'),
				L('Для порожніх полів шукає значення, надруковані в PDF статті, а також у реєстрах ORCID і ROR. Нічого не змінює — лише показує знайдене.',
					'For empty fields, looks for values printed in the article PDF and in the ORCID and ROR registries. Changes nothing — only shows what was found.'),
				'<button type="button" class="rg-primary" data-run="proposals"' + dis + '>' + L('Знайти', 'Find') + '</button>', state.proposalsReady)
			+ step(3, L('Переглянути й записати', 'Review and save'),
				L('Позначте потрібне й запишіть. Записуються лише порожні поля; кожне збереження потрапляє в історію змін, звідки його можна повернути.',
					'Tick what you need and save. Only empty fields are filled; every save goes to the change history and can be restored from there.'),
				(propCount ? '<button type="button" class="rg-primary" data-review="1"' + dis + '>' + L('Переглянути знайдене', 'Review findings') + ' (' + propCount + ')</button> ' : '')
				+ '<button type="button" data-run="history"' + dis + '>' + L('Історія змін', 'Change history') + (historyCount != null ? ' (' + historyCount + ')' : '') + '</button>', false)
			+ '</div>';
	}

	function selectedIds() {
		return keys(state.selected).filter(function (id) { return state.selected[id]; }).map(function (id) { return parseInt(id, 10); });
	}

	/** Панель дій для вибраних статей. */
	function selectionBar(shown) {
		var ids = selectedIds(), dis = state.running ? ' disabled' : '';
		var html = '<div class="ir-selbar">';
		if (!ids.length) {
			return html + '<span class="rg-muted">' + L('Позначте статті прапорцями, щоб опрацювати лише їх: знайти відсутні дані або знайти й одразу записати.',
				'Tick articles to process only them: find missing data, or find and save right away.') + '</span></div>';
		}
		html += '<strong>' + L('Вибрано: ', 'Selected: ') + ids.length + '</strong> '
			+ '<button type="button" data-batch="find"' + dis + '>' + L('Знайти дані для вибраних', 'Find data for selected') + '</button> ';
		if (state.confirmBatch) {
			html += '<span class="ir-confirm">' + L('Знайти й записати для ' + ids.length + ' ' + P(ids.length, ['статті', 'статей', 'статей'], []) + ' усі значення, крім позначених низькою надійністю?',
				'Find and save for ' + ids.length + ' ' + P(ids.length, [], ['article', 'articles']) + ' all values except low-reliability ones?') + '</span> '
				+ '<button type="button" class="rg-danger" data-batch="auto"' + dis + '>' + L('Так, опрацювати', 'Yes, process') + '</button> '
				+ '<button type="button" data-batch="cancel">' + L('Ні', 'No') + '</button> ';
		} else {
			html += '<button type="button" class="rg-primary" data-batch="ask"' + dis + '>' + L('Знайти й записати без перегляду', 'Find and save without review') + '</button> ';
		}
		html += '<button type="button" class="rg-link" data-batch="clear">' + L('зняти вибір', 'clear selection') + '</button>'
			+ '<div class="rg-muted ir-hint">' + L('«Без перегляду» записує лише значення із середньою й високою надійністю і лише в порожні поля; усе потрапляє в історію змін і може бути повернуто.',
				'“Without review” saves only medium- and high-reliability values and only into empty fields; everything goes to the change history and can be restored.') + '</div>';
		return html + '</div>';
	}

	async function runBatch(ids, autoSave) {
		await runProposals(ids);
		if (autoSave) {
			var withProps = ids.filter(function (id) { return (state.proposals[id] || []).some(function (p) { return p.checked; }); });
			if (withProps.length) { await applyFor(withProps); } else { state.notice = L('Для вибраних статей нових даних не знайдено.', 'No new data found for the selected articles.'); }
		}
	}

	function render() {
		if (!state.data) { return; }
		SEV = sevInfo();
		document.documentElement.lang = LANG;
		var d = state.data, j = d.journal, rows = buildRows(), shown = filterRows(rows), busy = !!state.running;
		var total = rows.length, propCount = 0, propArticles = 0;
		keys(state.proposals).forEach(function (id) {
			var n = (state.proposals[id] || []).filter(function (p) { return p.checked; }).length;
			if (n) { propCount += n; propArticles++; }
		});
		var dis = busy ? ' disabled' : '';

		var html = '<header class="rg-head"><div><h2>' + L('Готовність статей до індексування', 'Indexing readiness of articles') + '</h2>'
			+ '<p class="rg-muted">' + esc(j.name) + ' · ' + L('дані OJS станом на ', 'OJS data as of ') + esc(fmtDate(d.generatedAt)) + '</p></div>'
			+ '<div class="ir-head-right"><button type="button" class="rg-link" data-csv="1"' + (total ? '' : ' disabled') + '>' + L('Експорт CSV', 'Export CSV') + '</button> '
			+ '<span class="ir-lang" role="group" aria-label="Language">'
			+ '<button type="button" data-lang="uk"' + (LANG === 'uk' ? ' class="ir-lang-on" aria-pressed="true"' : '') + '>Українська</button>'
			+ '<button type="button" data-lang="en"' + (LANG === 'en' ? ' class="ir-lang-on" aria-pressed="true"' : '') + '>English</button></span></div></header>';

		html += stepsBlock(busy, propCount, propArticles);

		if (busy) { html += '<div class="rg-progress"><span class="rg-spinner"></span> <span class="rg-progress-text">' + esc(state.progress || L('Виконується…', 'Working…')) + '</span></div>'; }
		if (state.notice) { html += '<div class="rg-note ir-notice">' + esc(state.notice) + '</div>'; }

		if (state.showHistory && state.history) { html += historyBlock(); }

		var never = '<em>' + L('не виконувалася', 'not run yet') + '</em>';
		html += '<p class="rg-note">' + L('Бал рахується окремо для кожної системи: ', 'The score is calculated separately for each service: ')
			+ '<strong>GS</strong> — Google Scholar; <strong>RG</strong> — ResearchGate; <strong>CR</strong> — OpenAlex, Semantic Scholar, Dimensions ' + L('(дані з Crossref)', '(data from Crossref)')
			+ '; <strong>OAI</strong> — BASE, OpenAIRE, DOAJ (OAI-PMH). '
			+ L('Останні перевірки: Crossref — ', 'Last checks: Crossref — ') + (state.crossrefCheckedAt ? esc(fmtDate(state.crossrefCheckedAt)) : never)
			+ L('; сторінки — ', '; pages — ') + (state.pagesCheckedAt ? esc(fmtDate(state.pagesCheckedAt)) : never)
			+ '; PDF — ' + (state.pdfCheckedAt ? esc(fmtDate(state.pdfCheckedAt)) : never) + '.</p>';

		html += '<div class="rg-cards">' + card(L('Опубліковано статей', 'Published articles'), total, '');
		SYSTEMS.forEach(function (s) {
			var avg = total ? Math.round(rows.reduce(function (t, r) { return t + r.score[s.id]; }, 0) / total) : 0;
			var ready = rows.filter(function (r) { return r.score[s.id] >= READY; }).length;
			html += card(s.name + L(' · готових ', ' · ready ') + ready + L(' з ', ' of ') + total, avg + '/100', levelCls(avg),
				L('Середній бал і кількість статей з балом від ', 'Average score and number of articles scoring at least ') + READY);
		});
		html += '</div>';

		var ji = evaluateJournal(j);
		html += '<section class="rg-section"><h3>' + L('Налаштування журналу', 'Journal settings') + '</h3>'
			+ (ji.length ? issueList(ji) : '<p class="rg-okline">' + L('Налаштування журналу не потребують змін.', 'The journal settings need no changes.') + '</p>') + '</section>';

		if (state.proposalsReady) {
			html += '<section class="rg-section ir-apply" id="ir-apply"><h3>' + L('Знайдені дані для порожніх полів', 'Data found for empty fields') + '</h3>';
			if (!propCount) {
				html += '<p class="rg-muted">' + (keys(state.results).length ? L('Позначених пропозицій більше немає.', 'No selected proposals left.') : L('Даних для порожніх полів не знайдено.', 'No data found for empty fields.'))
					+ ' ' + L('Плагін заповнює лише порожні поля й бере лише те, що надруковано в статті або є в реєстрах ORCID і ROR; нічого не вигадує.',
						'The plugin fills empty fields only and uses only what is printed in the article or recorded in the ORCID and ROR registries; it invents nothing.') + '</p>';
			} else {
				html += '<p>' + L('Знайдено <strong>' + propCount + '</strong> ' + P(propCount, ['значення', 'значення', 'значень'], []) + ' у <strong>' + propArticles + '</strong> ' + P(propArticles, ['статті', 'статтях', 'статтях'], []) + '. Нижче, у списку статей, вони розгорнуті: перевірте їх, за потреби виправте або зніміть позначку.',
					'<strong>' + propCount + '</strong> ' + P(propCount, [], ['value', 'values']) + ' found in <strong>' + propArticles + '</strong> ' + P(propArticles, [], ['article', 'articles']) + '. They are expanded in the article list below: check them, edit or untick if needed.')
					+ ' ' + L('Записуються лише позначені значення і лише в порожні поля.', 'Only ticked values are saved, and only into empty fields.') + '</p>'
					+ depositCheckbox('')
					+ (state.confirmAll
						? '<button type="button" class="rg-danger" data-apply-all="confirm"' + dis + '>' + L('Так, записати ' + propCount + ' ' + P(propCount, ['значення', 'значення', 'значень'], []), 'Yes, save ' + propCount + ' ' + P(propCount, [], ['value', 'values'])) + '</button> <button type="button" data-apply-all="cancel">' + L('Ні', 'No') + '</button>'
						: '<button type="button" class="rg-primary" data-apply-all="ask"' + dis + '>' + L('Записати все позначене', 'Save all ticked') + '</button>');
			}
			html += '</section>';
		}

		var top = topProblems(rows);
		if (top.length) {
			var visible = state.showAllTop ? top : top.slice(0, TOP_LIMIT);
			html += '<section class="rg-section"><h3>' + L('Найпоширеніші проблеми', 'Most common problems') + '</h3><table class="rg-table"><thead><tr><th>' + L('Рівень', 'Level') + '</th><th>' + L('Проблема', 'Problem')
				+ '</th><th>' + L('Системи', 'Services') + '</th><th class="rg-num">' + L('Статей', 'Articles') + '</th><th>' + L('Рекомендація', 'Recommendation') + '</th></tr></thead><tbody>'
				+ visible.map(function (t) {
					return '<tr><td>' + badge(t.sev) + '</td><td>' + esc(t.text) + '</td><td>' + sysChips(t.sys) + '</td><td class="rg-num">' + t.count + '</td><td>' + esc(t.fix) + '</td></tr>';
				}).join('') + '</tbody></table>';
			if (top.length > TOP_LIMIT) {
				html += '<button type="button" class="ir-more" data-top-toggle="1" aria-expanded="' + (state.showAllTop ? 'true' : 'false') + '">'
					+ (state.showAllTop ? L('▲ Згорнути', '▲ Show less')
						: L('▼ Показати всі проблеми (ще ' + (top.length - TOP_LIMIT) + ')', '▼ Show all problems (' + (top.length - TOP_LIMIT) + ' more)')) + '</button>';
			}
			html += '</section>';
		}

		html += '<section class="rg-section"><h3>' + L('Статті', 'Articles') + '</h3><div class="rg-filters">'
			+ '<select data-system="1"><option value="all">' + L('Усі системи (найнижчий бал)', 'All services (lowest score)') + '</option>' + SYSTEMS.map(function (s) {
				return '<option value="' + s.id + '"' + (state.system === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>';
			}).join('') + '</select>'
			+ '<select data-filter="1">' + [['all', L('Усі статті', 'All articles')], ['critical', L('З критичними проблемами', 'With critical problems')],
				['notready', L('Не готові (<', 'Not ready (<') + READY + ')'], ['ready', L('Готові (≥', 'Ready (≥') + READY + ')'], ['license', L('З проблемами ліцензії', 'With licence problems')], ['norefs', L('Без списку літератури', 'Without references')],
				['proposals', L('Зі знайденими даними', 'With found data')], ['selected', L('Вибрані', 'Selected')]].map(function (o) {
				return '<option value="' + o[0] + '"' + (state.filter === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
			}).join('') + '</select>'
			+ '<input type="search" data-query="1" placeholder="' + esc(L('Пошук за назвою, DOI, випуском', 'Search by title, DOI, issue')) + '" value="' + esc(state.query) + '">'
			+ '<span class="rg-muted">' + L('Показано ', 'Showing ') + shown.length + L(' з ', ' of ') + total + '</span></div>';

		if (!total) {
			html += '<p class="rg-muted">' + L('У журналі ще немає опублікованих статей.', 'The journal has no published articles yet.') + '</p>';
		} else {
			html += selectionBar(shown);
			var allSel = shown.length && shown.every(function (r) { return state.selected[r.a.id]; });
			html += '<table class="rg-table rg-articles"><thead><tr><th class="ir-sel"><input type="checkbox" data-select-all="1" title="' + esc(L('Вибрати всі показані', 'Select all shown')) + '"' + (allSel ? ' checked' : '') + '></th><th>' + L('Стаття', 'Article') + '</th><th>DOI</th>'
				+ SYSTEMS.map(function (s) { return '<th class="rg-num" title="' + esc(s.name) + '">' + s.short + '</th>'; }).join('')
				+ '<th>' + L('Проблеми', 'Problems') + '</th></tr></thead><tbody>';
			shown.forEach(function (r) {
				var a = r.a, open = !!state.open[a.id], nProps = (state.proposals[a.id] || []).length;
				var c = { critical: 0, important: 0, minor: 0 };
				r.issues.forEach(function (i) { c[i.sev]++; });
				html += '<tr' + (state.selected[a.id] ? ' class="ir-row-sel"' : '') + '><td class="ir-sel"><input type="checkbox" data-select="' + a.id + '"' + (state.selected[a.id] ? ' checked' : '') + '></td>'
					+ '<td><a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.title || ('#' + a.id)) + '</a>'
					+ '<div class="rg-muted">' + esc(a.issue) + (a.editUrl ? ' · <a href="' + esc(a.editUrl) + '" target="_top">' + L('редагувати', 'edit') + '</a>' : '') + '</div></td>'
					+ '<td class="rg-doi">' + (a.doi ? '<a href="https://doi.org/' + esc(a.doi) + '" target="_blank" rel="noopener">' + esc(a.doi) + '</a>' : '—') + '</td>'
					+ SYSTEMS.map(function (s) { return '<td class="rg-num"><span class="rg-score rg-' + levelCls(r.score[s.id]) + '" title="' + esc(s.name + ': ' + levelLabel(r.score[s.id])) + '">' + r.score[s.id] + '</span></td>'; }).join('')
					+ '<td>' + (c.critical ? badge('critical') + ' ' + c.critical + ' ' : '') + (c.important ? badge('important') + ' ' + c.important + ' ' : '') + (c.minor ? badge('minor') + ' ' + c.minor + ' ' : '')
					+ (r.issues.length ? '' : '<span class="rg-okline">' + L('Без зауважень', 'No remarks') + '</span> ')
					+ (nProps ? '<span class="ir-chip ir-chip-prop">' + L('знайдено: ', 'found: ') + nProps + '</span> ' : '')
					+ ((r.issues.length || nProps || state.results[a.id]) ? '<button type="button" class="rg-link" data-toggle="' + a.id + '">' + (open ? L('згорнути', 'collapse') : L('деталі', 'details')) + '</button>' : '')
					+ '</td></tr>';
				if (open) {
					html += '<tr class="rg-details"><td></td><td colspan="' + (3 + SYSTEMS.length) + '">' + (r.issues.length ? issueList(r.issues) : '') + proposalBlock(a) + '</td></tr>';
				}
			});
			html += '</tbody></table>';
		}
		html += '</section>';

		app.innerHTML = html;
		bind(rows);
		fitFrame();
	}

	function propRef(attr) {
		var parts = attr.split(':');
		return { a: parseInt(parts[0], 10), i: parseInt(parts[1], 10), field: parts[2] };
	}

	function bind(rows) {
		function on(sel, ev, fn) { app.querySelectorAll(sel).forEach(function (el) { el.addEventListener(ev, function (e) { fn(el, e); }); }); }
		on('[data-lang]', 'click', function (b) {
			LANG = b.getAttribute('data-lang');
			try { localStorage.setItem(LANG_KEY, LANG); } catch (e) { /* сховище недоступне */ }
			render();
		});
		on('[data-run]', 'click', function (b) { run(b.getAttribute('data-run')); });
		on('[data-csv]', 'click', function () { exportCsv(filterRows(rows)); });
		on('[data-filter]', 'change', function (s) { state.filter = s.value; render(); });
		on('[data-system]', 'change', function (s) { state.system = s.value; render(); });
		on('[data-query]', 'input', function (inp) {
			state.query = inp.value;
			var pos = inp.selectionStart;
			render();
			var again = app.querySelector('[data-query]');
			again.focus();
			try { again.setSelectionRange(pos, pos); } catch (e) { /* не підтримується */ }
		});
		on('[data-select]', 'change', function (cb) { state.selected[cb.getAttribute('data-select')] = cb.checked; state.confirmBatch = false; render(); });
		on('[data-select-all]', 'change', function (cb) {
			filterRows(rows).forEach(function (r) { state.selected[r.a.id] = cb.checked; });
			state.confirmBatch = false;
			render();
		});
		on('[data-batch]', 'click', function (b) {
			var v = b.getAttribute('data-batch'), ids = selectedIds();
			if (v === 'clear') { state.selected = {}; state.confirmBatch = false; render(); }
			else if (v === 'ask') { state.confirmBatch = true; render(); }
			else if (v === 'cancel') { state.confirmBatch = false; render(); }
			else if (v === 'find') { run('batch-find', ids); }
			else if (v === 'auto') { run('batch-auto', ids); }
		});
		on('[data-top-toggle]', 'click', function () { state.showAllTop = !state.showAllTop; render(); });
		on('button[data-toggle]', 'click', function (b) { var id = b.getAttribute('data-toggle'); state.open[id] = !state.open[id]; render(); });
		on('[data-prop]', 'change', function (cb) { var r = propRef(cb.getAttribute('data-prop')); state.proposals[r.a][r.i].checked = cb.checked; render(); });
		on('[data-edit]', 'input', function (el) { var r = propRef(el.getAttribute('data-edit')); state.proposals[r.a][r.i][r.field] = el.value; });
		on('[data-edit-name]', 'input', function (el) { var r = propRef(el.getAttribute('data-edit-name')); state.proposals[r.a][r.i].names[r.field] = el.value; });
		on('[data-alt]', 'change', function (s) {
			var r = propRef(s.getAttribute('data-alt')), p = state.proposals[r.a][r.i], alt = p.alternatives[parseInt(s.value, 10)];
			p.value = alt.value; p.heading = alt.heading; p.count = alt.count; p.source = alt.source; p.rejected = alt.rejected || [];
			render();
		});
		on('[data-deposit]', 'change', function (cb) { state.deposit = cb.checked; render(); });
		on('[data-apply-one]', 'click', function (b) { run('apply', [parseInt(b.getAttribute('data-apply-one'), 10)]); });
		on('[data-apply-all]', 'click', function (b) {
			var v = b.getAttribute('data-apply-all');
			if (v === 'ask') { state.confirmAll = true; render(); }
			else if (v === 'cancel') { state.confirmAll = false; render(); }
			else { run('apply', keys(state.proposals).map(function (x) { return parseInt(x, 10); })); }
		});
		on('[data-rollback-ask]', 'click', function (b) {
			var id = b.getAttribute('data-rollback-ask');
			state.confirmRollback = id;
			state.historyOpen = state.historyOpen || {};
			state.historyOpen[id] = true;
			render();
		});
		on('[data-rollback-cancel]', 'click', function () { state.confirmRollback = null; render(); });
		on('[data-rollback]', 'click', function (b) { state.confirmRollback = null; run('rollback', b.getAttribute('data-rollback')); });
		on('[data-hopen]', 'click', function (b) {
			var id = b.getAttribute('data-hopen');
			state.historyOpen = state.historyOpen || {};
			state.historyOpen[id] = !state.historyOpen[id];
			render();
		});
		on('[data-history-more]', 'click', function () { state.historyLimit = (state.historyLimit || HISTORY_PAGE) + HISTORY_PAGE; render(); });
		on('[data-review]', 'click', function () { openProposals(); render(); scrollToApply(); });
		on('[data-history-close]', 'click', function () { state.showHistory = false; render(); });
	}

	// ------------------------------------------------------------------
	// Старт
	// ------------------------------------------------------------------

	loadCache();
	window.addEventListener('resize', fitFrame);
	Promise.all([reloadData(), checkRobots(), loadHistory().catch(function () { state.history = null; })])
		.then(function () { return checkOai(); })
		.then(render)
		.catch(function (e) {
			app.innerHTML = '<p class="rg-error">' + L('Не вдалося завантажити дані про статті: ', 'Could not load article data: ') + esc(e.message || e) + '</p>';
			fitFrame();
		});
}());
