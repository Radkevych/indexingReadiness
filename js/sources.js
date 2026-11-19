/**
 * plugins/generic/indexingReadiness/js/sources.js
 *
 * Distributed under the GNU GPL v3.
 *
 * Джерела даних для доповнення метаданих:
 *  - PDF-гранки (pdf.js у браузері): англомовні анотація, ключові слова, назва,
 *    список літератури, ORCID;
 *  - відкриті реєстри ORCID і ROR;
 *  - транслітерація українських імен за постановою КМУ від 27.01.2010 № 55.
 */
(function (global) {
	'use strict';

	var IR = global.IR = global.IR || {};

	// ------------------------------------------------------------------
	// Транслітерація (постанова КМУ № 55 від 27.01.2010)
	// ------------------------------------------------------------------

	var TR = {
		'а': 'a', 'б': 'b', 'в': 'v', 'г': 'h', 'ґ': 'g', 'д': 'd', 'е': 'e', 'є': 'ie', 'ж': 'zh',
		'з': 'z', 'и': 'y', 'і': 'i', 'ї': 'i', 'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n',
		'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts',
		'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ь': '', 'ю': 'iu', 'я': 'ia', '\'': '', '’': '', 'ʼ': '', '`': ''
	};
	// На початку слова
	var TR_START = { 'є': 'ye', 'ї': 'yi', 'й': 'y', 'ю': 'yu', 'я': 'ya' };

	function translitWord(word) {
		var out = '', lower = word.toLowerCase();
		for (var i = 0; i < lower.length; i++) {
			var ch = lower[i], prev = i > 0 ? lower[i - 1] : '';
			var t;
			if (ch === 'г' && prev === 'з') {
				t = 'gh'; // «зг» → «zgh»
			} else if (i === 0 && TR_START[ch]) {
				t = TR_START[ch];
			} else if (Object.prototype.hasOwnProperty.call(TR, ch)) {
				t = TR[ch];
			} else {
				t = ch;
			}
			if (word[i] !== lower[i] && t) {
				t = t.charAt(0).toUpperCase() + t.slice(1);
			}
			out += t;
		}
		return out;
	}

	IR.translit = function (text) {
		return String(text || '').replace(/[А-Яа-яІіЇїЄєҐґ'’ʼ`]+/g, translitWord);
	};

	IR.hasCyrillic = function (text) {
		return /[А-Яа-яІіЇїЄєҐґ]/.test(text || '');
	};

	IR.latinRatio = function (text) {
		var letters = String(text || '').match(/\p{L}/gu) || [];
		if (!letters.length) { return 0; }
		var latin = letters.filter(function (c) { return /[A-Za-z]/.test(c); }).length;
		return latin / letters.length;
	};

	// ------------------------------------------------------------------
	// Нормалізація й порівняння імен
	// ------------------------------------------------------------------

	function normName(s) {
		return IR.translit(String(s || '')).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
	}

	function lev(a, b) {
		var m = a.length, n = b.length, d = [], i, j;
		for (i = 0; i <= m; i++) { d[i] = [i]; }
		for (j = 0; j <= n; j++) { d[0][j] = j; }
		for (i = 1; i <= m; i++) {
			for (j = 1; j <= n; j++) {
				d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			}
		}
		return d[m][n];
	}

	/** Чи збігаються прізвища з урахуванням різних варіантів транслітерації. */
	IR.sameFamilyName = function (a, b) {
		var x = normName(a), y = normName(b);
		if (!x || !y) { return false; }
		if (x === y) { return true; }
		var tolerance = Math.max(1, Math.floor(Math.min(x.length, y.length) / 4));
		return lev(x, y) <= tolerance;
	};

	// ------------------------------------------------------------------
	// ORCID
	// ------------------------------------------------------------------

	IR.orcidChecksumOk = function (id) {
		var digits = String(id).replace(/[^0-9Xx]/g, '').toUpperCase();
		if (digits.length !== 16) { return false; }
		var total = 0;
		for (var i = 0; i < 15; i++) { total = (total + parseInt(digits[i], 10)) * 2; }
		var check = (12 - (total % 11)) % 11;
		return (check === 10 ? 'X' : String(check)) === digits[15];
	};

	IR.orcidBare = function (value) {
		var m = String(value || '').match(/(\d{4})-?(\d{4})-?(\d{4})-?(\d{3}[\dXx])/);
		return m ? (m[1] + '-' + m[2] + '-' + m[3] + '-' + m[4].toUpperCase()) : '';
	};

	var orcidCache = {};

	/** Ім'я з публічного профілю ORCID: { given, family, other[] } або null. */
	IR.orcidPerson = function (orcid) {
		var id = IR.orcidBare(orcid);
		if (!id) { return Promise.resolve(null); }
		if (orcidCache[id]) { return orcidCache[id]; }
		orcidCache[id] = fetch('https://pub.orcid.org/v3.0/' + id + '/person', {
			credentials: 'omit', headers: { 'Accept': 'application/json' }
		}).then(function (res) {
			if (!res.ok) { return null; }
			return res.json().then(function (j) {
				var name = j && j.name;
				if (!name) { return { given: '', family: '', other: [] }; }
				return {
					given: (name['given-names'] && name['given-names'].value) || '',
					family: (name['family-name'] && name['family-name'].value) || '',
					other: ((j['other-names'] && j['other-names']['other-name']) || []).map(function (o) { return o.content; })
				};
			});
		}).catch(function () { return null; });
		return orcidCache[id];
	};

	// ------------------------------------------------------------------
	// ROR
	// ------------------------------------------------------------------

	var rorCache = {};

	/** Найкращий збіг ROR для назви установи: { id, name, score } або null. */
	// Службові слова, що не розрізняють установи.
	var ORG_STOP = { of: 1, the: 1, and: 1, for: 1, at: 1, in: 1, named: 1, after: 1, 'і': 1, 'й': 1, 'та': 1, 'в': 1, 'у': 1, 'імені': 1, 'ім': 1 };

	function orgTokens(text) {
		return String(text || '').toLowerCase().replace(/[«»"“”'’().,;:–—-]+/g, ' ').split(/\s+/)
			.filter(function (t) { return t && !ORG_STOP[t]; });
	}

	/**
	 * Наскільки дві назви установи збігаються за значущими словами:
	 * { a: частка слів першої назви, знайдених у другій; b: навпаки }.
	 */
	IR.orgSimilarity = function (x, y) {
		var A = orgTokens(x), B = orgTokens(y);
		if (!A.length || !B.length) { return { a: 0, b: 0 }; }
		var inB = A.filter(function (t) { return B.indexOf(t) !== -1; }).length;
		var inA = B.filter(function (t) { return A.indexOf(t) !== -1; }).length;
		return { a: inB / A.length, b: inA / B.length };
	};

	// Загальні слова в назвах установ: вони не відрізняють одну установу від іншої.
	var ORG_GENERIC = ('institute institution university academy national state ukraine ukrainian education educational science sciences '
		+ 'research centre center college school naes nas napn nasu ministry '
		+ 'інститут університет академія академії національний національна національної державний державна державного '
		+ 'україни український українська освіти наук науковий центр напн нан міністерство').split(' ');

	function isGeneric(t) { return ORG_GENERIC.indexOf(t) !== -1; }

	function orgMatches(affiliation, names) {
		var A = orgTokens(affiliation), best = null;
		names.forEach(function (n) {
			var B = orgTokens(n), s = IR.orgSimilarity(affiliation, n);
			// Усі розрізнювальні слова (напр. «vocational», «pedagogy», «Shevchenko») мають збігатися в обох назвах.
			var distinctOk = A.filter(function (t) { return !isGeneric(t); }).every(function (t) { return B.indexOf(t) !== -1; })
				&& B.filter(function (t) { return !isGeneric(t); }).every(function (t) { return A.indexOf(t) !== -1; });
			var hasDistinct = A.concat(B).some(function (t) { return !isGeneric(t); });
			var ok = distinctOk && (hasDistinct ? (s.a >= 0.8 && s.b >= 0.6) : (s.a === 1 && s.b === 1));
			if (ok && (!best || s.a + s.b > best.a + best.b)) { best = { a: s.a, b: s.b, name: n }; }
		});
		return best;
	}
	IR.orgMatches = orgMatches;

	var rorCache = {};

	/**
	 * Ідентифікатор ROR для назви установи. Позначка «chosen» сервісу ROR сама по собі
	 * не є достатньою (вона буває хибною), тому запис приймається лише тоді, коли одна
	 * з його назв (основна, варіант, абревіатура чи переклад) збігається з назвою
	 * установи за значущими словами. Інакше — null.
	 */
	IR.rorMatch = function (affiliationName) {
		var key = String(affiliationName || '').trim();
		if (!key) { return Promise.resolve(null); }
		if (rorCache[key]) { return rorCache[key]; }
		rorCache[key] = fetch('https://api.ror.org/v2/organizations?affiliation=' + encodeURIComponent(key), { credentials: 'omit' })
			.then(function (res) { return res.ok ? res.json() : null; })
			.then(function (j) {
				var result = null;
				((j && j.items) || []).forEach(function (it) {
					var org = it.organization || {};
					var names = (org.names || []).map(function (n) { return n.value; });
					var m = orgMatches(key, names);
					if (m && (!result || m.a + m.b > result.sim)) {
						var display = (org.names || []).filter(function (n) { return (n.types || []).indexOf('ror_display') !== -1; })[0];
						result = { id: org.id, name: display ? display.value : names[0], matchedName: m.name, sim: m.a + m.b, exact: m.a === 1 && m.b === 1 };
					}
				});
				return result;
			})
			.catch(function () { return null; });
		return rorCache[key];
	};

	// ------------------------------------------------------------------
	// PDF: читання тексту
	// ------------------------------------------------------------------

	var pdfjsPromise = null;

	function loadPdfjs(cfg) {
		if (!pdfjsPromise) {
			pdfjsPromise = import(cfg.pdfjsUrl).then(function (lib) {
				lib.GlobalWorkerOptions.workerSrc = cfg.pdfjsWorkerUrl;
				return lib;
			});
		}
		return pdfjsPromise;
	}

	/**
	 * Групування текстових фрагментів сторінки в рядки з урахуванням колонок.
	 * Рядок ділиться на сегменти за великими проміжками; якщо на сторінці є
	 * вертикальний проміжок між колонками, текст колонок виводиться послідовно
	 * (спершу ліва, потім права) в межах кожної смуги між рядками на всю ширину.
	 */
	function pageLines(items) {
		var rows = [];
		items.forEach(function (it) {
			if (!it.str || !it.transform) { return; }
			var y = it.transform[5], x = it.transform[4], h = Math.abs(it.transform[3]) || it.height || 10;
			var row = null;
			for (var i = rows.length - 1; i >= 0 && i >= rows.length - 6; i--) {
				if (Math.abs(rows[i].y - y) <= Math.max(2, h * 0.4)) { row = rows[i]; break; }
			}
			if (!row) { row = { y: y, h: h, parts: [] }; rows.push(row); }
			row.h = Math.max(row.h, h);
			row.parts.push({ x: x, s: it.str, w: it.width || 0 });
		});
		rows.sort(function (a, b) { return b.y - a.y; });

		// Сегменти рядка
		var segs = [];
		rows.forEach(function (r, ri) {
			r.parts.sort(function (a, b) { return a.x - b.x; });
			var cur = null;
			r.parts.forEach(function (p) {
				var gap = cur ? p.x - cur.x1 : 0;
				if (cur && gap > Math.max(14, r.h * 2.2)) { segs.push(cur); cur = null; }
				if (!cur) { cur = { row: ri, y: r.y, h: r.h, x0: p.x, x1: p.x + p.w, text: '' }; }
				else if (gap > 1.5 && !/\s$/.test(cur.text) && !/^\s/.test(p.s)) { cur.text += ' '; }
				cur.text += p.s;
				cur.x1 = Math.max(cur.x1, p.x + p.w);
			});
			if (cur) { segs.push(cur); }
		});
		segs = segs.filter(function (sg) { sg.text = sg.text.replace(/\s+/g, ' ').trim(); return sg.text; });

		// Пошук проміжку між колонками
		var gutter = null, best = 0;
		segs.map(function (sg) { return sg.x1 + 2; }).sort(function (a, b) { return a - b; }).forEach(function (g) {
			var left = 0, right = 0, cross = 0;
			segs.forEach(function (sg) {
				if (sg.x1 <= g) { left++; } else if (sg.x0 >= g) { right++; } else { cross++; }
			});
			var score = Math.min(left, right);
			if (left >= 5 && right >= 5 && cross <= 0.25 * segs.length && score > best) { best = score; gutter = g; }
		});

		var out = [];
		function emit(sg) { out.push({ text: sg.text, h: sg.h, x: sg.x0 }); }
		function joinRow(list) {
			if (!list.length) { return null; }
			return { text: list.map(function (x) { return x.text; }).join(' '), h: Math.max.apply(null, list.map(function (x) { return x.h; })), x0: list[0].x0 };
		}
		var byRow = {};
		segs.forEach(function (sg) { (byRow[sg.row] = byRow[sg.row] || []).push(sg); });
		var rowIds = Object.keys(byRow).map(Number).sort(function (a, b) { return a - b; });
		if (gutter === null) {
			rowIds.forEach(function (ri) { emit(joinRow(byRow[ri])); });
			return out;
		}
		var L = [], R = [];
		function flush() { L.forEach(emit); R.forEach(emit); L = []; R = []; }
		rowIds.forEach(function (ri) {
			var list = byRow[ri];
			if (list.some(function (sg) { return sg.x0 < gutter && sg.x1 > gutter; })) {
				flush();
				emit(joinRow(list));
			} else {
				var l = joinRow(list.filter(function (sg) { return sg.x1 <= gutter; }));
				var r = joinRow(list.filter(function (sg) { return sg.x0 >= gutter; }));
				if (l) { L.push(l); }
				if (r) { R.push(r); }
			}
		});
		flush();
		return out;
	}

	/** Прибирає колонтитули: рядки, що повторюються на багатьох сторінках. */
	function dropRunningLines(lines, pages) {
		if (pages < 3) { return lines; }
		var count = {}, seen = {};
		lines.forEach(function (l) {
			var key = l.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
			var pk = key + '@' + l.page;
			if (!seen[pk]) { seen[pk] = true; count[key] = (count[key] || 0) + 1; }
		});
		var limit = Math.max(3, Math.ceil(pages * 0.3));
		return lines.filter(function (l) {
			var key = l.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
			return count[key] < limit && !/^#{1,4}$/.test(key);
		});
	}

	/**
	 * Завантажує PDF і повертає { size, pages, chars, firstPage, lines[] }.
	 * Для дуже довгих файлів читає перші 4 та останні 20 сторінок.
	 */
	IR.readPdf = function (cfg, url) {
		var size = 0;
		return fetch(url, { credentials: 'same-origin' })
			.then(function (res) {
				if (!res.ok) { throw new Error('HTTP ' + res.status); }
				return res.arrayBuffer();
			})
			.then(function (buf) {
				size = buf.byteLength;
				return loadPdfjs(cfg).then(function (lib) {
					return lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
				});
			})
			.then(async function (doc) {
				var n = doc.numPages, pagesToRead = [];
				for (var p = 1; p <= n; p++) {
					if (n <= 80 || p <= 4 || p > n - 20) { pagesToRead.push(p); }
				}
				var lines = [], chars = 0, firstPage = '', edges = [];
				for (var k = 0; k < pagesToRead.length; k++) {
					var page = await doc.getPage(pagesToRead[k]);
					var content = await page.getTextContent();
					var pl = pageLines(content.items);
					pl.forEach(function (l) { chars += l.text.length; l.page = pagesToRead[k]; lines.push(l); });
					if (pagesToRead[k] === 1) { firstPage = pl.map(function (l) { return l.text; }).join('\n'); }
					// Перші й останні рядки сторінки: тут друкують колонтитули з номером сторінки.
					var texts = pl.map(function (l) { return l.text; });
					edges.push({ index: pagesToRead[k], texts: texts.slice(0, 3).concat(texts.slice(-3)) });
					page.cleanup();
				}
				await doc.destroy();
				lines = dropRunningLines(lines, pagesToRead.length);
				return { size: size, pages: n, chars: chars, firstPage: firstPage, lines: lines, edges: edges };
			});
	};

	// ------------------------------------------------------------------
	// PDF: розбір структури статті
	// ------------------------------------------------------------------

	var RE = {
		refHeading: /^(references|reference list|list of references|bibliography|список\s+(використаних\s+)?(джерел|літератури)|використані\s+джерела|використана\s+література|література|джерела)(?!\p{L})[^.]{0,60}$/iu,
		refHeadingLatin: /^(references|reference list|list of references|bibliography)\b/i,
		refEnd: /^(information about (the )?authors?|about the authors?|відомості про (автор|авторів)|інформація про (автор|авторів)|manuscript received|received(?!\p{L})|accepted(?!\p{L})|стаття надійшла|надійшла до редакції|дата надходження|cite this|to cite this|citation:|для цитування|conflict of interest|конфлікт інтересів|acknowledg|doi:\s*https?:)/iu,
		sectionStart: /^(introduction|вступ|постановка проблеми|problem statement|formulation of the problem|statement of the problem)(?!\p{L})/iu,
		numbered: /^\s*\[?(\d{1,3})[\].)]\s+/,
		absSection: /^(background|relevance|purpose|aims?|objectives?|methods?|methodology|results?|findings|conclusions?|originality|актуальність|мета|метою|методи|методологія|результати|висновки|перспективи)(?!\p{L})\s*[.:]/iu,
		authorStart: /^\p{Lu}[\p{L}'’-]+,?\s+(?:\p{Lu}\p{Ll}?\.\s?){1,3}/u,
		nextArticle: /^(удк|udc|udk)(?![\p{L}])|^issn(?![\p{L}])/iu,
		udcInside: /(?:^|\s)(удк|udc|udk)\s*\d/iu,
		bio: /(доктор|кандидат)\s+\S+\s+наук|doctor of|candidate of|ph\.?\s?d\.? in|кафедри|відділу|department of|senior researcher|науковий співробітник|докторант|аспірант/iu,
		langMark: /\[(in [A-Za-z]+|англ[^\]]*|укр[^\]]*|рос[^\]]*)\]\.?$/i,
		orcid: /(?:orcid\.org\/)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/gi
	};

	var LANGS = {
		en: {
			abs: /^(abstract|summary)\b\s*[.:—–-]?\s*/i,
			kw: /^key\s*-?\s*words?\b\s*[.:—–-]?\s*/i,
			ok: function (t) { return IR.latinRatio(t) > 0.85; }
		},
		uk: {
			abs: /^(анотація|реферат|резюме)(?!\p{L})\s*[.:—–-]?\s*/iu,
			kw: /^ключові\s+слова(?!\p{L})\s*[.:—–-]?\s*/iu,
			ok: function (t) { return IR.hasCyrillic(t) && IR.latinRatio(t) < 0.2 && isUkrainian(t); }
		}
	};

	function isUkrainian(t) {
		var uk = (String(t).match(/[іїєґІЇЄҐ]/g) || []).length;
		var ru = (String(t).match(/[ыэъёЫЭЪЁ]/g) || []).length;
		return uk > 0 && uk >= ru * 2;
	}

	function anyAbstractHeading(t) { return LANGS.en.abs.test(t) || LANGS.uk.abs.test(t); }
	function anyKeywordsHeading(t) { return LANGS.en.kw.test(t) || LANGS.uk.kw.test(t) || /^ключевые\s+слова/i.test(t); }

	function joinProse(lines) {
		var out = '';
		lines.forEach(function (t) {
			if (!out) { out = t; return; }
			if (/[\p{L}]-$/u.test(out) && /^\p{Ll}/u.test(t)) {
				out = out.slice(0, -1) + t;
			} else {
				out += ' ' + t;
			}
		});
		return out.replace(/\s+/g, ' ').trim();
	}

	function bodyFontSize(lines) {
		var weight = {};
		lines.forEach(function (l) { var k = Math.round(l.h); weight[k] = (weight[k] || 0) + l.text.length; });
		var best = 10, max = 0;
		Object.keys(weight).forEach(function (k) { if (weight[k] > max) { max = weight[k]; best = Number(k); } });
		return best;
	}

	function findAbstract(L, lang, big) {
		var def = LANGS[lang];
		for (var i = 0; i < L.length; i++) {
			var m = L[i].text.match(def.abs);
			if (!m) { continue; }
			var first = L[i].text.slice(m[0].length).trim();
			var body = first ? [first] : [];
			var j = i + 1;
			for (; j < L.length && j < i + 90; j++) {
				var t = L[j].text;
				if (anyKeywordsHeading(t) || anyAbstractHeading(t) || RE.refHeading.test(t) || RE.sectionStart.test(t) || RE.refEnd.test(t) || L[j].h >= big) { break; }
				body.push(t);
			}
			// Пропускаємо початкові рядки з назвою, іменами й відомостями про авторів.
			while (body.length > 3 && (body[0].length < 60 || NOT_TITLE.test(body[0]))) { body.shift(); }
			// Структуровану анотацію ділимо на абзаци за її рубриками.
			var paras = [[]];
			body.forEach(function (t) {
				if (RE.absSection.test(t) && paras[paras.length - 1].length) { paras.push([]); }
				paras[paras.length - 1].push(t);
			});
			var text = paras.map(joinProse).filter(Boolean).join('\n\n');
			if (text.length >= 200 && def.ok(text)) {
				return { text: text.slice(0, 8000), line: i, end: j };
			}
		}
		return null;
	}

	function findKeywords(L, lang, from) {
		var def = LANGS[lang];
		for (var pass = 0; pass < 2; pass++) {
			for (var i = pass === 0 ? (from || 0) : 0; i < L.length; i++) {
				var m = L[i].text.match(def.kw);
				if (!m) { continue; }
				var parts = [L[i].text.slice(m[0].length)];
				for (var j = i + 1; j < L.length && j <= i + 6; j++) {
					var t = L[j].text;
					// Продовження списку: тим самим письмом (рядок може не мати характерних літер мови).
					var sameScript = lang === 'en' ? IR.latinRatio(t) > 0.85 : (IR.hasCyrillic(t) && IR.latinRatio(t) < 0.2);
					if (/[.]$/.test(parts.join(' ').trim()) || anyAbstractHeading(t) || anyKeywordsHeading(t) || RE.sectionStart.test(t) || RE.refEnd.test(t) || !sameScript || t.length > 200) { break; }
					parts.push(t);
				}
				var raw = joinProse(parts).replace(/\.$/, '');
				if (!def.ok(raw)) { continue; }
				var list = raw.split(/\s*[;,]\s*/).map(function (k) { return k.replace(/^[\s.–—-]+|[\s.]+$/g, ''); })
					.filter(function (k) { return k.length >= 2 && k.length <= 120; });
				if (list.length) { return list.slice(0, 25); }
			}
		}
		return null;
	}

	/**
	 * Статистика написання слів в основному тексті: чи слово трапляється
	 * з великої літери всередині речення (власна назва) або повністю великими (абревіатура).
	 */
	function caseStats(L, big) {
		var st = {};
		L.forEach(function (l) {
			if (l.h >= big) { return; }
			var letters = l.text.replace(/[^\p{L}]/gu, '');
			if (letters && letters.replace(/[^\p{Lu}]/gu, '').length / letters.length > 0.6) { return; }
			var words = l.text.split(/\s+/);
			words.forEach(function (w, i) {
				var m = w.match(/^[«"“(]*([\p{L}][\p{L}'’-]*)/u);
				if (!m) { return; }
				var word = m[1], key = word.toLowerCase(), prev = i > 0 ? words[i - 1] : '';
				var e = st[key] || (st[key] = { cap: 0, low: 0, upper: 0 });
				if (word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase()) { e.upper++; }
				else if (word[0] !== word[0].toLowerCase()) { if (i > 0 && !/[.!?:]$/.test(prev)) { e.cap++; } }
				else { e.low++; }
			});
		});
		return st;
	}

	function smartCase(text, st) {
		var first = true;
		return text.split(/(\s+)/).map(function (tok) {
			if (/^\s+$/.test(tok)) { return tok; }
			var out = tok.replace(/[\p{L}][\p{L}'’-]*/gu, function (w) {
				var key = w.toLowerCase(), e = st[key];
				if (!e && key.length >= 6) {
					// Відмінкові форми: шукаємо слово з тією самою основою.
					var stem = key.slice(0, key.length - 2);
					Object.keys(st).some(function (k) {
						if (k.indexOf(stem) === 0 && st[k].cap >= 1 && st[k].cap > st[k].low) { e = st[k]; return true; }
						return false;
					});
				}
				var r;
				if (e && e.upper >= 1 && e.upper >= e.low && w.length <= 6) { r = w.toUpperCase(); }
				else if (e && e.cap >= 1 && e.cap > e.low) { r = key.charAt(0).toUpperCase() + key.slice(1); }
				else { r = key; }
				if (first) { r = r.charAt(0).toUpperCase() + r.slice(1); first = false; }
				return r;
			});
			return out;
		}).join('');
	}

	function titleResult(text, st) {
		text = text.replace(/\s+/g, ' ').trim();
		if (text.length < 15 || text.length > 400 || text.split(' ').length < 3) { return null; }
		var letters = text.replace(/[^\p{L}]/gu, '');
		var upper = letters.replace(/[^\p{Lu}]/gu, '').length / Math.max(1, letters.length);
		if (upper > 0.8) {
			return { text: smartCase(text, st || {}), confidence: 'low', note: 'caps' };
		}
		return { text: text, confidence: 'medium' };
	}

	var NOT_TITLE = /@|orcid|https?:|www\.|\b(university|institute|academy|department|faculty|college|school|ministry|e-?mail|ukraine|kyiv|kiev|phd|doctor|professor|candidate|senior|lecturer|researcher|associate|student|ph\.d|д\.\s?пед|канд|доктор|професор|університет|інститут|академ)(?!\p{L})/iu;

	/** Назва мовою lang: блок рядків збільшеного кегля; запасний варіант — рядки перед анотацією. */
	function findTitle(L, lang, big, abstractLine, authors) {
		var def = LANGS[lang], blocks = [], cur = null;
		L.forEach(function (l, i) {
			if (l.h >= big && !/^(розділ|section|chapter)(?!\p{L})/iu.test(l.text)) {
				if (cur && cur.end === i - 1 && cur.page === l.page) { cur.lines.push(l.text); cur.end = i; }
				else { cur = { start: i, end: i, page: l.page, lines: [l.text] }; blocks.push(cur); }
			}
		});
		var candidates = blocks.map(function (b) { b.text = joinProse(b.lines); return b; })
			.filter(function (b) { return def.ok(b.text) && b.text.length >= 15; });
		if (candidates.length) {
			var pick = candidates[0];
			if (abstractLine != null) {
				candidates.forEach(function (b) { if (b.end < abstractLine && abstractLine - b.end < 40) { pick = b; } });
			}
			return titleResult(pick.text, caseStats(L, big));
		}
		if (abstractLine == null || lang !== 'en') { return null; }
		var names = [];
		(authors || []).forEach(function (a) { familyNames(a).forEach(function (f) { if (f) { names.push(f.toLowerCase()); } }); });
		var block = [], started = false;
		for (var i = abstractLine - 1; i >= 0 && i >= abstractLine - 25; i--) {
			var t = L[i].text, low = t.toLowerCase();
			var isName = names.some(function (n) { return low.indexOf(n) !== -1; }) || /^(\p{Lu}[\p{Ll}'’-]+\s+){1,2}\p{Lu}[\p{Ll}'’-]+\d?,?$/u.test(t);
			var looks = def.ok(t) && /[A-Za-z]{3}/.test(t) && !NOT_TITLE.test(t) && !/^\d/.test(t) && !/[A-Z]\.\s?[A-Z]\./.test(t) && !isName;
			if (looks) { block.unshift(t); started = true; } else if (started) { break; }
		}
		return block.length ? titleResult(joinProse(block), caseStats(L, big)) : null;
	}

	function splitReferences(lines) {
		var numbered = lines.filter(function (t) { return RE.numbered.test(t); }).length >= 3;
		var items = [], cur = '';
		function push() {
			var s = cur.replace(/\s+/g, ' ').trim().replace(RE.numbered, '');
			if (s.length >= 20) { items.push(s); }
			cur = '';
		}
		lines.forEach(function (t) {
			var prev = cur.trim();
			var starts = numbered ? RE.numbered.test(t)
				: (RE.langMark.test(prev) || (RE.authorStart.test(t) && /[.)\]\d]$|\S+\/\S*$/.test(prev)));
			if (starts && cur) { push(); }
			if (!cur) {
				cur = t;
			} else if (/(https?:\/\/|doi\.org\/|www\.)\S*$/.test(cur) && !/\s$/.test(cur) && !/^\p{Lu}\p{Ll}/u.test(t) && !/^\[/.test(t)) {
				cur += t; // розірвана адреса чи DOI
			} else if (/[\p{L}]-$/u.test(cur) && /^\p{Ll}/u.test(t)) {
				cur = cur.slice(0, -1) + t;
			} else {
				cur += ' ' + t;
			}
		});
		if (cur) { push(); }
		return items;
	}

	/**
	 * Відбір бібліографічних описів. Відкидаються фрагменти, що не схожі на опис:
	 * початок наступної статті (УДК, назва, відомості про автора) і уривки без року
	 * та без адреси. Якщо в описі трапляється «УДК», текст після нього відкидається.
	 */
	function checkReferences(list) {
		var items = [], rejected = [], stopped = false;
		list.forEach(function (text) {
			// Після початку наступної статті нічого не беремо.
			if (stopped) { rejected.push(text); return; }
			var cut = text.search(RE.udcInside);
			if (cut >= 0) { stopped = true; }
			if (cut > 0) {
				rejected.push(text.slice(cut).trim());
				text = text.slice(0, cut).trim();
			} else if (cut === 0) {
				rejected.push(text);
				return;
			}
			var hasYear = /(^|[^\d])(1[89]\d{2}|20\d{2})([^\d]|$)/.test(text);
			var hasLink = /(https?:\/\/|doi\.org|www\.)/i.test(text);
			var looksBio = RE.bio.test(text);
			if (text.length < 25 || (!hasYear && !hasLink) || (looksBio && !hasYear)) {
				rejected.push(text);
			} else {
				items.push(text);
			}
		});
		return { items: items, rejected: rejected };
	}

	function findReferenceLists(L, big) {
		var lists = [];
		for (var i = 0; i < L.length; i++) {
			var head = L[i].text;
			if (!RE.refHeading.test(head) || head.length > 70) { continue; }
			var body = [];
			for (var j = i + 1; j < L.length; j++) {
				var t = L[j].text;
				// Кінець списку: службові розділи, наступна стаття (УДК, назва), анотація іншою мовою.
				if (RE.refEnd.test(t) || RE.nextArticle.test(t) || (RE.refHeading.test(t) && t.length <= 70) || anyAbstractHeading(t) || L[j].h >= big) { break; }
				if (/^\d{1,4}$/.test(t)) { continue; }
				body.push(t);
			}
			var checked = checkReferences(splitReferences(body));
			if (checked.items.length >= 2) {
				lists.push({ heading: head.replace(/[:.]\s*$/, ''), latin: RE.refHeadingLatin.test(head), items: checked.items.slice(0, 300), rejected: checked.rejected });
			}
			i = j - 1;
		}
		return lists;
	}

	function findOrcids(L, authors) {
		var found = [];
		L.forEach(function (l, i) {
			var m, re = new RegExp(RE.orcid.source, 'gi');
			while ((m = re.exec(l.text))) {
				var id = m[1].toUpperCase();
				if (!IR.orcidChecksumOk(id) || found.some(function (f) { return f.orcid === id; })) { continue; }
				var owner = null, bestDist = 99;
				(authors || []).forEach(function (a) {
					var fams = familyNames(a).map(function (f) { return f.toLowerCase(); });
					for (var d = 0; d <= 6; d++) {
						var probe = [L[i - d], d ? null : l, L[i + 1]].filter(Boolean);
						var hit = probe.some(function (p) { var low = p.text.toLowerCase(); return fams.some(function (f) { return f && low.indexOf(f) !== -1; }); });
						if (hit) {
							if (d < bestDist) { bestDist = d; owner = a.id; } else if (d === bestDist && owner !== a.id) { owner = null; }
							break;
						}
					}
				});
				found.push({ orcid: id, authorId: owner });
			}
		});
		return found;
	}

	function familyNames(author) {
		var out = [];
		Object.keys(author.familyName || {}).forEach(function (loc) {
			var f = author.familyName[loc];
			if (f) {
				out.push(f);
				if (IR.hasCyrillic(f)) { out.push(IR.translit(f)); }
			}
		});
		return out;
	}
	IR.familyNames = familyNames;

	// ------------------------------------------------------------------
	// Відомості про авторів, надруковані в статті
	// ------------------------------------------------------------------

	var ORG = /(інститут|університет|академі[яї]|коледж|ліцей|гімназі[яї]|центр|міністерств|агенці[яї]|institute|university|universit[àa]|academy|college|school|centre|center|ministry|agency|lyceum)/i;
	var EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

	/** Ділить рядок за комами поза дужками. */
	function splitTop(text) {
		var out = [], depth = 0, cur = '';
		for (var i = 0; i < text.length; i++) {
			var ch = text[i];
			if (ch === '(') { depth++; } else if (ch === ')') { depth = Math.max(0, depth - 1); }
			if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else { cur += ch; }
		}
		if (cur.trim()) { out.push(cur.trim()); }
		return out;
	}

	var POSITION = /(researcher|professor|lecturer|fellow|head\b|director|teacher|student|candidate|doctor|співробітник|професор|доцент|викладач|завідувач|директор|аспірант|здобувач|кандидат|доктор)/i;
	var PLACE = /^(ukraine|україна|kyiv|kiev|київ|м\.\s*київ|kharkiv|харків|lviv|львів|odesa|одеса|dnipro|дніпро|poltava|полтава|chernihiv|чернігів|vinnytsia|вінниця|zhytomyr|житомир|sumy|суми|[0-9 -]{5,})$/i;

	/** Назва установи з абзацу відомостей про автора (без посади, підрозділу, міста й ідентифікаторів). */
	function affiliationFrom(text) {
		var parts = splitTop(text.replace(/https?:\/\/\S+/g, ' ').replace(EMAIL, ' ').replace(/\b(e-?mail|orcid( id)?|електронна пошта)\s*:?/ig, ' '));
		for (var i = 0; i < parts.length; i++) {
			var seg = parts[i].replace(/\s+/g, ' ').trim();
			if (!ORG.test(seg) || /^(department|chair|faculty|laboratory|кафедр|відділ|лабораторі|факультет)/i.test(seg)) { continue; }
			// «Senior Researcher at Institute …» → «Institute …»
			var at = seg.search(/\s(at|в|у)\s(?=\p{Lu})/u);
			if (at > 0 && POSITION.test(seg.slice(0, at))) {
				seg = seg.slice(at).replace(/^\s(at|в|у)\s/u, '');
			}
			// Назву беремо лише як окрему частину, що починається з великої літери і без посади перед нею.
			// Фрагменти на кшталт «співробітник відділу … Інституту …» (назва в непрямому відмінку) пропускаємо.
			if (!/^\p{Lu}/u.test(seg) || POSITION.test(seg.slice(0, Math.max(0, seg.search(ORG))))) { continue; }
			var name = [seg];
			for (var j = i + 1; j < parts.length && !PLACE.test(parts[j].trim()) && parts[j].trim(); j++) {
				if (ORG.test(parts[j]) || /^(the\s)?(national|state|ukrainian|national academy|національн|державн)/i.test(parts[j])) { name.push(parts[j].trim()); } else { break; }
			}
			var result = name.join(', ').replace(/[\s.;]+$/, '');
			if (result.length >= 8 && result.length <= 300) { return result; }
		}
		return '';
	}

	function nameTokens(text) {
		return String(text).replace(/[0-9*†,]+/g, ' ').split(/\s+/).filter(function (t) { return /^\p{L}[\p{L}'’-]+$/u.test(t); });
	}

	/** Рядок з ім'ям автора: коротко, без цифр і службових слів, містить прізвище одного з авторів. */
	function authorOfLine(text, authors) {
		if (text.length > 70 || /\d{3}|@|https?:|orcid|abstract|анотація|реферат/i.test(text)) { return null; }
		var tokens = nameTokens(text);
		if (tokens.length < 2 || tokens.length > 6) { return null; }
		var found = null;
		authors.forEach(function (a) {
			familyNames(a).forEach(function (f) {
				tokens.forEach(function (t, idx) {
					if (!found && IR.sameFamilyName(f, t)) { found = { author: a, familyIndex: idx, tokens: tokens }; }
				});
			});
		});
		return found;
	}

	/**
	 * Блоки «ім'я — відомості» для кожного автора в кожній мовній частині статті.
	 * @return {Object} authorId -> [{ latin, given, family, affiliation, email, orcid }]
	 */
	function findAuthorBlocks(L, authors, big) {
		var out = {};
		if (!authors || !authors.length) { return out; }
		for (var i = 0; i < L.length; i++) {
			var hit = authorOfLine(L[i].text, authors);
			if (!hit) { continue; }
			var info = [];
			for (var j = i + 1; j < L.length && j <= i + 7; j++) {
				var t = L[j].text;
				if (authorOfLine(t, authors) || anyAbstractHeading(t) || anyKeywordsHeading(t) || L[j].h >= big || RE.sectionStart.test(t)) { break; }
				info.push(t);
			}
			// Відомості можуть стояти й у тому самому рядку після імені.
			var text = joinProse(info);
			if (!text) { continue; }
			var tokens = hit.tokens, fi = hit.familyIndex;
			var orcidMatch = text.match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i);
			var emailMatch = text.match(EMAIL);
			var block = {
				latin: IR.latinRatio(tokens.join(' ')) > 0.9,
				given: tokens.filter(function (t, k) { return k !== fi; }).join(' '),
				family: tokens[fi],
				affiliation: affiliationFrom(text),
				affiliationLatin: false,
				email: emailMatch ? emailMatch[0].replace(/[.,;]+$/, '') : '',
				orcid: orcidMatch && IR.orcidChecksumOk(orcidMatch[1]) ? orcidMatch[1].toUpperCase() : ''
			};
			block.affiliationLatin = block.affiliation ? IR.latinRatio(block.affiliation) > 0.85 : false;
			if (block.affiliation || block.email || block.orcid) {
				(out[hit.author.id] = out[hit.author.id] || []).push(block);
			}
		}
		return out;
	}

	/**
	 * Сторінки статті: діапазон «pp. 135-144» у вихідних даних або
	 * послідовність номерів у колонтитулах, узгоджена з кількістю сторінок файлу.
	 */
	function findPages(pdf) {
		var n = pdf.pages, fromText = null, fromSeq = null;
		var head = pdf.lines.slice(0, 40).map(function (l) { return l.text; }).join(' ');
		(pdf.edges || []).forEach(function (e) { if (e.index === 1) { head += ' ' + e.texts.join(' '); } });
		var m = head.match(/(?:^|[^\p{L}])(?:pp?|рр?|с|сс|стор)\.?\s*(\d{1,4})\s*[-–—]\s*(\d{1,4})(?!\d)/iu);
		if (m) {
			var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
			if (b >= a && Math.abs((b - a + 1) - n) <= 2) { fromText = a + '-' + b; }
		}
		var offsets = {};
		(pdf.edges || []).forEach(function (e) {
			var seen = {};
			e.texts.forEach(function (t) {
				var nums = t.match(/(?:^|\s)(\d{1,4})(?=\s*$)|^(\d{1,4})(?=\s)/g) || [];
				nums.forEach(function (x) {
					var v = parseInt(x, 10), off = v - e.index;
					if (off >= 0 && !seen[off]) { seen[off] = true; offsets[off] = (offsets[off] || 0) + 1; }
				});
			});
		});
		var best = null;
		Object.keys(offsets).forEach(function (k) { if (!best || offsets[k] > offsets[best]) { best = k; } });
		var pagesRead = (pdf.edges || []).length;
		if (best !== null && offsets[best] >= Math.max(3, Math.ceil(pagesRead * 0.6))) {
			var off = parseInt(best, 10);
			fromSeq = (1 + off) + '-' + (n + off);
		}
		if (fromText && fromSeq) { return { value: fromText, confidence: fromText === fromSeq ? 'high' : 'low' }; }
		if (fromText || fromSeq) { return { value: fromText || fromSeq, confidence: 'medium' }; }
		return null;
	}

	/**
	 * Розбір тексту PDF статті.
	 * @return {{langs: {en: {abstract, keywords, title}, uk: {...}}, references[], orcids[]}}
	 */
	IR.parseArticle = function (pdf, article) {
		var L = pdf.lines;
		var body = bodyFontSize(L), big = body * 1.4;
		var langs = {};
		Object.keys(LANGS).forEach(function (lang) {
			var abs = findAbstract(L, lang, big);
			langs[lang] = {
				abstract: abs ? abs.text : null,
				keywords: findKeywords(L, lang, abs ? abs.end : 0),
				title: findTitle(L, lang, big, abs ? abs.line : null, article.authors)
			};
		});
		return {
			langs: langs,
			references: findReferenceLists(L, big),
			orcids: findOrcids(L, article.authors || []),
			authors: findAuthorBlocks(L, article.authors || [], big),
			pages: findPages(pdf)
		};
	};

	/** Частка значущих слів назви, знайдених на першій сторінці PDF. */
	IR.titleOnFirstPage = function (firstPage, titles) {
		var page = String(firstPage || '').toLowerCase().replace(/\s+/g, ' ');
		var best = 0;
		Object.keys(titles || {}).forEach(function (loc) {
			var words = String(titles[loc]).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(function (w) { return w.length >= 4; });
			if (!words.length) { return; }
			var hit = words.filter(function (w) { return page.indexOf(w) !== -1; }).length;
			best = Math.max(best, hit / words.length);
		});
		return best;
	};
}(window));
