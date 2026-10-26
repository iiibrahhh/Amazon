/* تصنيف حالة الشحن الدولي — يعتمد على الأدلة فقط.
   لا يستخدم وحده: اسم البائع، بلد البائع، العلامة التجارية، موعد/مدة التوصيل.
   الاستثناء الوحيد (قرينة مركّبة → «مرجح» لا «مؤكد»): الشاحن هو البائع نفسه (وليس أمازون) + مهلة تجهيز طويلة
   أو موعد توصيل بعيد جدًا. Amazon.sa لا تذكر بلد الشحن لهذه العروض، فلا يمكن التأكيد من الصفحة. */
(function (root, factory) {
  const dep = (n) => (typeof module === 'object' && module.exports) ? require('./' + n + '.js') : root.ASF[n];
  const api = factory(dep('rules'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.classifier = api; }
})(typeof self !== 'undefined' ? self : this, function (rules) {

  const { normalizeText, foldForMatch, foreignCountryAtStart, isSaudiAtStart,
    PATTERNS, SHIPS_FROM_COUNTRY_RES } = rules;

  const SNIP = 240;
  function snippet(s) { const t = normalizeText(s); return t.length > SNIP ? t.slice(0, SNIP) + '…' : t; }

  const BUSINESS_WORDS = /\b(?:co|ltd|llc|inc|trading|store|stores|shop|company|electronics|limited|group|corp|market|mart)\b|شركه|مؤسسه|متجر|للتجاره|التجاريه/;
  const CONNECTORS = /^(?:and|sold|by|from|via|&|\||و|ويباع|يباع|ويتم|ومباع|مباع)(?![a-z\u0621-\u064a])/;

  function restAfterCountry(text, country) {
    const t = foldForMatch(text).replace(/^(the|ال)\s+/, '').trim();
    return t.slice(country.name.length).trim();
  }
  /** قيمة حقل «يشحن من»: يجب أن تكون اسم دولة (مع إضافة قصيرة مثل مدينة)، لا اسم شركة تبدأ باسم دولة. */
  function countryFromFieldValue(text) {
    const c = foreignCountryAtStart(text);
    if (!c) return null;
    const rest = restAfterCountry(text, c);
    if (!rest) return c;
    if (BUSINESS_WORDS.test(rest)) return null;
    return rest.replace(/[()\[\],.\-–]/g, ' ').split(/\s+/).filter(Boolean).length <= 2 ? c : null;
  }
  /** نص حر «ships from X ...»: بعد اسم الدولة يجب أن تأتي نهاية الجملة أو رابط (and/sold/…) لا اسم شركة. */
  function countryFromSentence(text) {
    const c = foreignCountryAtStart(text);
    if (!c) return null;
    const rest = restAfterCountry(text, c);
    if (!rest || /^[.,;:()\-–|]/.test(rest) || CONNECTORS.test(rest)) return c;
    return null;
  }

  /**
   * @param {object} f  حقول الشحن المستخرجة: shipsFrom, soldBy, fulfillerText, deliveryText,
   *                    importFeesText, badges[], blockText
   * @param {object} opts  { importFeesAsConfirmed, source, url, now }
   * @returns {{status, originCountry, originNote, evidence[], notes[]}}
   */
  function classifyShipping(f, opts) {
    opts = opts || {};
    f = f || {};
    const evidence = [];
    const notes = [];
    const seen = new Set();

    function add(signal, strength, field, text, extra) {
      const key = signal + '|' + field + '|' + (extra && extra.country || '');
      if (seen.has(key)) return;
      seen.add(key);
      evidence.push(Object.assign({
        signal, strength, field, text: snippet(text),
        source: opts.source || 'amazon.sa:product-page',
        url: opts.url || null,
        checkedAt: opts.now || new Date().toISOString()
      }, extra || {}));
    }

    // 1) حقل "يشحن من" / "الشاحن" المنظّم (إن وُجد)
    const sf = normalizeText(f.shipsFrom);
    if (sf) {
      const folded = foldForMatch(sf);
      if (f.shipsFromIsName) {
        // قيمة حقل «الشاحن» اسم جهة (غالبًا البائع) لا مكان: لا نفسّرها كدولة حتى لو بدأت باسم دولة
        if (/^(amazon\.sa|amazon sa|amazon|امازون|امازون\.sa)$/.test(folded)) add('ships_from_field_amazon', 'local', 'shipsFrom', sf);
        else if (/amazon\s*global|amazon\.com|امازون\s*العالمي/.test(folded)) add('ships_from_field_amazon_global', 'likely', 'shipsFrom', sf);
        else notes.push('حقل «الشاحن» يحتوي اسم جهة لا يدل على بلد الشحن: ' + snippet(sf));
      } else {
        const foreign = countryFromFieldValue(sf);
        if (foreign) {
          add('ships_from_field_foreign_country', 'confirmed', 'shipsFrom', sf, { country: foreign.code });
        } else if (isSaudiAtStart(sf)) {
          add('ships_from_field_saudi', 'local', 'shipsFrom', sf);
        } else if (/^(amazon\.sa|amazon sa|amazon|امازون|امازون\.sa)$/.test(folded)) {
          add('ships_from_field_amazon', 'local', 'shipsFrom', sf);
        } else if (/amazon\s*global|amazon\.com|امازون\s*العالمي/.test(folded)) {
          add('ships_from_field_amazon_global', 'likely', 'shipsFrom', sf);
        } else {
          // اسم جهة (غالبًا البائع نفسه): لا يدل على المكان
          notes.push('حقل «يشحن من» يحتوي اسم جهة لا يدل على بلد الشحن: ' + snippet(sf));
        }
      }
    }

    // 2) أنماط نصية في كل مصدر نصي
    const sources = [
      ['shipsFrom', f.shipsFrom && !f.shipsFromIsName ? 'ships from ' + f.shipsFrom : ''],   // اسم جهة (شاحن) ليس مكانًا: لا نركّب منه «ships from»
      ['fulfillerText', f.fulfillerText],
      ['deliveryText', f.deliveryText],
      ['importFeesText', f.importFeesText],
      ['badges', (f.badges || []).join(' | ')],
      ['blockText', f.blockText]
    ];
    for (const [field, raw] of sources) {
      const text = normalizeText(raw);
      if (!text) continue;
      const folded = foldForMatch(text);

      for (const p of PATTERNS) {
        if (p.re.test(folded)) {
          let strength = p.strength;
          if (opts.importFeesAsConfirmed && /^import_fees/.test(p.id)) strength = 'confirmed';
          add(p.id, strength, field, text);
        }
      }
      for (const re0 of SHIPS_FROM_COUNTRY_RES) {
        const re = new RegExp(re0.source, re0.flags);
        let m;
        while ((m = re.exec(folded))) {
          const cap = m[1] || '';
          const foreign = countryFromSentence(cap);
          if (foreign) add('ships_from_text_foreign_country', 'confirmed', field, text, { country: foreign.code });
          else if (isSaudiAtStart(cap)) add('ships_from_text_saudi', 'local', field, text);
          if (m[0].length === 0) re.lastIndex++;
        }
      }
    }

    // 2.5) قرينة مركّبة: الشاحن = البائع (وليس أمازون) + مهلة تجهيز طويلة / موعد توصيل بعيد
    const minHandling = Number(opts.intlMinHandlingDays) > 0 ? Number(opts.intlMinHandlingDays) : 5;
    const minDelivery = Number(opts.intlMinDeliveryDays) > 0 ? Number(opts.intlMinDeliveryDays) : 14;
    const minTransit = Number(opts.intlMinTransitDays) > 0 ? Number(opts.intlMinTransitDays) : 4;
    const h = f.handling || (f.handlingMinDays !== undefined && f.handlingMinDays !== null ? { minDays: f.handlingMinDays, maxDays: f.handlingMaxDays } : null);
    const d = f.deliveryWindow || (f.deliveryMinDays !== undefined && f.deliveryMinDays !== null ? { minDays: f.deliveryMinDays, maxDays: f.deliveryMaxDays } : null);
    const hasLocalEvidence = evidence.some(e => e.strength === 'local');
    if (f.shipperType === 'seller' && !hasLocalEvidence) {
      const longHandling = !!(h && h.minDays >= minHandling);
      const longDelivery = !!(d && d.minDays >= minDelivery);
      // فارق النقل = أقرب توصيل − أطول تجهيز: الوقت المتبقي للنقل بعد خروج الشحنة من عند البائع.
      // الشحن داخل المملكة عادة يومان إلى ثلاثة؛ فارق كبير يرجّح أن الشحنة تقطع مسافة أطول (قرينة لا دليل).
      const transitMin = (h && d && h.maxDays !== null && h.maxDays !== undefined) ? d.minDays - h.maxDays : null;
      const longTransit = transitMin !== null && transitMin >= minTransit;
      if (longHandling || longDelivery || longTransit) {
        const parts = ['الشاحن: ' + (f.shipperName || f.shipsFrom || f.soldBy || '—') + ' (جهة البيع/الشحن نفسها وليست أمازون)'];
        if (h) parts.push('مهلة التجهيز: ' + rules.rangeText(h.minDays, h.maxDays) + ' يوم');
        if (d) parts.push('التوصيل بعد ' + rules.rangeText(d.minDays, d.maxDays) + ' يومًا من الفحص' + (f.deliveryDate ? ' (' + f.deliveryDate + ')' : ''));
        if (longTransit) parts.push('فارق النقل المقدّر: ' + transitMin + ' أيام فأكثر (أقرب توصيل − أطول تجهيز)');
        const signal = longHandling && longDelivery ? 'seller_ships_long_handling_and_delivery' : longHandling ? 'seller_ships_long_handling' : longDelivery ? 'seller_ships_long_delivery' : 'seller_ships_long_transit';
        add(signal, 'likely', 'combined', parts.join(' · '));
        notes.push('تصنيف «مرجح» مبني على قرائن مجتمعة (شاحن = بائع + مدد طويلة)، وليس على نص يذكر بلد الشحن؛ Amazon.sa لا تعرض بلد الشحن لهذه العروض.');
      } else if (h || d) {
        notes.push('الشاحن هو البائع لكن مدد الشحن قصيرة (' + [transitMin !== null ? 'فارق النقل ' + transitMin + ' أيام' : null, h ? 'تجهيز ' + rules.rangeText(h.minDays, h.maxDays) + ' يوم' : null, d ? 'توصيل بعد ' + rules.rangeText(d.minDays, d.maxDays) + ' يومًا' : null].filter(Boolean).join('، ') + ') — لا قرينة كافية على شحن دولي.');
      }
    }

    // 3) الحسم
    const conf = evidence.filter(e => e.strength === 'confirmed');
    const lik = evidence.filter(e => e.strength === 'likely');
    const loc = evidence.filter(e => e.strength === 'local');
    let status;
    if (conf.length) {
      status = loc.length ? 'likely' : 'confirmed';
      if (loc.length) notes.push('تعارض بين أدلة الشحن الدولي والمحلي — خُفّض التصنيف إلى «مرجح».');
    } else if (lik.length) {
      status = loc.length ? 'unknown' : 'likely';
      if (loc.length) notes.push('تعارض بين قرائن دولية وأدلة محلية — التصنيف «غير معلوم».');
    } else if (loc.length) {
      status = 'local';
    } else {
      status = 'unknown';
      notes.push('لا توجد معلومات كافية عن بلد الشحن في المصدر.');
    }

    let originCountry = null;
    let originNote = null;
    if (status === 'confirmed') {
      const withCountry = conf.find(e => e.country);
      if (withCountry) originCountry = withCountry.country;
      else originNote = 'خارج السعودية (البلد غير محدد في النص)';
    }
    return { status, originCountry, originNote, evidence, notes };
  }

  return { classifyShipping };
});
