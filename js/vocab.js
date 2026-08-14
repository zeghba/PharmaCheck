/* =====================================================================
   PharmaCheck — prescription vocabulary

   The three concepts a medical prescription separates, kept as ordered
   lists so the entry form and the printed slip agree on wording. Labels are
   bilingual (French — English) because the terms are the French clinical
   standard and the UI is English.
   ===================================================================== */
(function (global) {
  'use strict';

  /* 1. Forme pharmaceutique — what the medicine itself is. */
  var FORMS = [
    { id: 'comprime',        label: 'Comprimé — tablet' },
    { id: 'gelule',          label: 'Gélule — capsule' },
    { id: 'sirop',           label: 'Sirop — syrup' },
    { id: 'sol-buvable',     label: 'Solution buvable — oral solution' },
    { id: 'susp-buvable',    label: 'Suspension buvable — oral suspension' },
    { id: 'gouttes',         label: 'Gouttes — drops' },
    { id: 'poudre',          label: 'Poudre — powder' },
    { id: 'granules',        label: 'Granulés — granules' },
    { id: 'suppositoire',    label: 'Suppositoire — suppository' },
    { id: 'ovule',           label: 'Ovule — vaginal pessary' },
    { id: 'creme',           label: 'Crème — cream' },
    { id: 'pommade',         label: 'Pommade — ointment' },
    { id: 'gel',             label: 'Gel — gel' },
    { id: 'lotion',          label: 'Lotion — lotion' },
    { id: 'spray',           label: 'Spray — spray' },
    { id: 'patch',           label: 'Patch — transdermal patch' },
    { id: 'sol-injectable',  label: 'Solution injectable — injectable solution' },
    { id: 'susp-injectable', label: 'Suspension injectable — injectable suspension' },
    { id: 'emulsion',        label: 'Émulsion — emulsion' }
  ];

  /* 2. Conditionnement — the container it comes in. */
  var PACKAGINGS = [
    { id: 'boite',        label: 'Boîte — box' },
    { id: 'plaquette',    label: 'Plaquette / blister — blister pack' },
    { id: 'flacon',       label: 'Flacon — bottle' },
    { id: 'compte-gouttes', label: 'Flacon compte-gouttes — dropper bottle' },
    { id: 'tube',         label: 'Tube — tube' },
    { id: 'ampoule',      label: 'Ampoule — ampoule' },
    { id: 'flacon-inj',   label: 'Flacon injectable — vial' },
    { id: 'seringue',     label: 'Seringue préremplie — pre-filled syringe' },
    { id: 'cartouche',    label: 'Cartouche — cartridge' },
    { id: 'sachet',       label: 'Sachet — sachet' },
    { id: 'pot',          label: 'Pot — jar' },
    { id: 'unidose',      label: 'Unidose — single-dose container' },
    { id: 'bidon',        label: 'Bidon — large container' }
  ];

  /* 3. Voie d'administration — how the patient takes it. */
  var ROUTES = [
    { id: 'orale',         label: 'Orale — oral' },
    { id: 'sublinguale',   label: 'Sublinguale — under the tongue' },
    { id: 'buccale',       label: 'Buccale — inside the cheek' },
    { id: 'nasale',        label: 'Nasale — nasal' },
    { id: 'inhalee',       label: 'Inhalée — inhaled' },
    { id: 'cutanee',       label: 'Cutanée — applied to skin' },
    { id: 'transdermique', label: 'Transdermique — transdermal' },
    { id: 'ophtalmique',   label: 'Ophtalmique — eye' },
    { id: 'auriculaire',   label: 'Auriculaire — ear' },
    { id: 'rectale',       label: 'Rectale — rectal' },
    { id: 'vaginale',      label: 'Vaginale — vaginal' },
    { id: 'sc',            label: 'Sous-cutanée (SC) — subcutaneous' },
    { id: 'im',            label: 'Intramusculaire (IM) — intramuscular' },
    { id: 'iv',            label: 'Intraveineuse (IV) — intravenous' }
  ];

  /* Common dose expressions, offered as suggestions rather than enforced. */
  var DOSES = [
    '1 comprimé', '2 comprimés', '½ comprimé', '1 gélule', '2 gélules',
    '1 cuillère à café (5 mL)', '1 cuillère à soupe (15 mL)',
    '5 mL', '10 mL', '15 mL', '20 mL',
    '1 sachet', '1 suppositoire', '1 ovule', '1 patch',
    '2 gouttes', '3 gouttes', '1 bouffée', '2 bouffées',
    '1 application', '1 ampoule'
  ];

  var FREQUENCIES = [
    '1 fois/jour — once daily',
    '2 fois/jour — twice daily',
    '3 fois/jour — three times daily',
    '4 fois/jour — four times daily',
    'Matin et soir — morning and evening',
    'Au coucher — at bedtime',
    'Toutes les 4 heures — every 4 hours',
    'Toutes les 6 heures — every 6 hours',
    'Toutes les 8 heures — every 8 hours',
    'Toutes les 12 heures — every 12 hours',
    'Si besoin — as needed',
    '1 fois/semaine — once weekly'
  ];

  var DURATIONS = [
    '3 jours — 3 days', '5 jours — 5 days', '7 jours — 7 days',
    '10 jours — 10 days', '14 jours — 14 days', '1 mois — 1 month',
    '3 mois — 3 months', '6 mois — 6 months', 'Traitement continu — ongoing'
  ];

  function labelFor(list, id) {
    var hit = list.find(function (x) { return x.id === id; });
    return hit ? hit.label : (id || '');
  }

  /* The bilingual labels are for the form; a slip or a QR payload wants the
     short human name, which is the part before the em dash. */
  function shortLabel(list, id) {
    return String(labelFor(list, id)).split(' — ')[0];
  }

  global.PharmaVocab = {
    FORMS: FORMS,
    PACKAGINGS: PACKAGINGS,
    ROUTES: ROUTES,
    DOSES: DOSES,
    FREQUENCIES: FREQUENCIES,
    DURATIONS: DURATIONS,
    labelFor: labelFor,
    shortLabel: shortLabel,
    formLabel: function (id) { return shortLabel(FORMS, id); },
    packagingLabel: function (id) { return shortLabel(PACKAGINGS, id); },
    routeLabel: function (id) { return shortLabel(ROUTES, id); }
  };
})(typeof self !== 'undefined' ? self : this);
