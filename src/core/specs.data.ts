/**
 * The country/document spec data.
 *
 * Separated from specs.ts (which holds the types and helpers) so this file is
 * pure data: adding a country is adding one object here, with no code changes.
 *
 * EVERY entry must carry a `sourceUrl` pointing at the issuing authority and a
 * `lastVerified` date. Both are rendered in the UI. Official requirements
 * drift, and a tool that silently serves stale rules is worse than one that
 * admits its data has an age.
 */

import type { BackgroundRule, PhotoSpec } from './specs'

/** US State Department: "plain white or off-white". */
export const WHITE_STRICT: BackgroundRule = {
  label: 'Plain white or off-white',
  minChannel: 232,
  maxSpread: 14,
  color: '#ffffff',
}

/** UK/EU style: "plain light grey or cream", tolerating a wider range. */
export const WHITE_TO_GREY: BackgroundRule = {
  label: 'Plain white through light grey',
  minChannel: 200,
  maxSpread: 20,
  color: '#f5f5f5',
}

/**
 * ------------------------------------------------------------------------
 * ON THE `eye` FIELD
 * ------------------------------------------------------------------------
 * Very few authorities publish an explicit pupil-line position; most specify
 * only a chin-to-crown head height. Where the authority IS explicit (US, and
 * the few others called out in their notes) the published numbers are used
 * verbatim.
 *
 * Everywhere else the range is *derived*, not quoted, using the proportional
 * band that the authorities which do publish one converge on — pupils between
 * 56% and 69% of the photo height above the bottom edge, starting at 62.5%.
 * (That band is exactly the US State Department's published 1.125"-1.375" in
 * a 2" photo, and it is consistent with the ICAO Doc 9303 / ISO-IEC 19794-5
 * full-frontal token image geometry.) Any entry relying on it says so in its
 * `notes`, so the UI never presents a derived number as a quoted rule.
 * ------------------------------------------------------------------------
 */

/** The derived-eye-line disclaimer, worded identically wherever it applies. */
const EYE_DERIVED =
  'The authority publishes no pupil-line height; this range follows the ICAO Doc 9303 convention (pupils 56-69% of photo height above the bottom edge).'

/** The derived-head disclaimer, for specs with no published head height. */
const HEAD_ICAO =
  'The authority publishes no chin-to-crown head height; this follows the ICAO Doc 9303 convention of a 32-36 mm head in a 45 mm photo.'

export const SPEC_REGISTRY: PhotoSpec[] = [
  {
    id: 'us-2x2',
    country: 'United States',
    countryCode: 'US',
    documents: ['Passport', 'Visa', 'Green Card', 'Citizenship'],
    unit: 'in',
    photoW: 2,
    photoH: 2,
    dpi: 300,
    head: { min: 1.0, max: 1.375, default: 1.19 },
    eye: { min: 1.125, max: 1.375, default: 1.25 },
    background: WHITE_STRICT,
    notes: [
      'Taken within the last 6 months.',
      'Neutral expression or a natural smile, both eyes open.',
      'No glasses. No hats or head coverings except for religious reasons.',
      'Plain white or off-white background with no shadows.',
    ],
    sourceUrl: 'https://travel.state.gov/en/passports/apply/help/photos.html',
    lastVerified: '2026-08-07',
  },
  {
    id: 'intl-35x45',
    // HM Passport Office publishes 29-34 mm, which is wider at the bottom than
    // the ICAO 32-36 mm band - a 30 mm head is valid in the UK and would have
    // been rejected by the narrower range this entry used to carry.
    country: 'United Kingdom',
    countryCode: 'GB',
    documents: ['Passport', 'Visa', 'Immigration'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 29, max: 34, default: 31.5 },
    eye: { min: 25, max: 31, default: 28 },
    // No `headroom`. HM Passport Office publishes no crown margin, and an
    // invented one here would be enforced as a hard FAIL in the compliance
    // panel — the app would reject a photo the UK would have accepted. Only
    // authorities that actually publish a crown margin (Japan, Russia) carry
    // this field.
    background: WHITE_TO_GREY,
    notes: [
      'Photo is 45 mm high by 35 mm wide, with the head 29-34 mm from crown to chin.',
      'Neutral expression with the mouth closed.',
      'No glasses unless medically required.',
      'Plain light-grey or cream background, evenly lit with no shadows.',
      EYE_DERIVED,
    ],
    sourceUrl: 'https://www.gov.uk/photos-for-passports/photo-requirements',
    lastVerified: '2026-08-07',
  },
  {
    // Canada is one of the few authorities using a 50x70 mm print, and it
    // publishes the chin-to-crown range explicitly. The eye line is derived.
    id: 'ca-50x70',
    country: 'Canada',
    countryCode: 'CA',
    documents: ['Passport', 'Travel Document'],
    unit: 'mm',
    photoW: 50,
    photoH: 70,
    dpi: 300,
    head: { min: 31, max: 36, default: 33.5 },
    eye: { min: 39, max: 48, default: 44 },
    background: WHITE_STRICT,
    notes: [
      'Face must measure 31-36 mm from chin to the crown of the head.',
      'Taken within the last 6 months; colour or black and white.',
      'Plain white background; avoid white clothing, which blends into it.',
      'No editing of any kind - filters, retouching and AI tools are rejected.',
      EYE_DERIVED,
    ],
    sourceUrl:
      'https://www.canada.ca/en/immigration-refugees-citizenship/services/canadian-passports/photos.html',
    lastVerified: '2026-08-07',
  },
  {
    // Germany's Fotomustertafel is the most precisely published spec in the
    // Schengen area: face height 32-36 mm, stated as 70-80% of the 45 mm frame.
    id: 'de-35x45',
    country: 'Germany',
    countryCode: 'DE',
    documents: ['Passport', 'ID Card', 'Residence Permit'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 32, max: 36, default: 34 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_TO_GREY,
    notes: [
      'Face height 32-36 mm chin to crown - published as 70-80% of the 45 mm frame.',
      'Neutral expression with the mouth closed; do not smile.',
      'Plain light background, ideally neutral grey, contrasting with hair and face.',
      'Glasses only if the frame does not cover the eyes and the lenses do not reflect.',
      EYE_DERIVED,
    ],
    sourceUrl: 'https://san-jose.diplo.de/cr-de/service/passbilder/1664946',
    lastVerified: '2026-08-07',
  },
  {
    // China publishes head *width* as well as height, which no other authority
    // in this registry does. Head width is carried in the notes only.
    id: 'cn-33x48',
    country: 'China',
    countryCode: 'CN',
    documents: ['Visa', 'Passport'],
    unit: 'mm',
    photoW: 33,
    photoH: 48,
    dpi: 300,
    head: { min: 28, max: 33, default: 30.5 },
    eye: { min: 27, max: 33, default: 30 },
    background: WHITE_STRICT,
    notes: [
      'Head height 28-33 mm chin to crown; head width 15-22 mm.',
      'Head tilt at most 20 degrees left/right and 25 degrees up/down.',
      'Colour photo taken within the last 6 months, white or near-white background.',
      'Neutral expression, eyes open, lips closed, both ears visible.',
      EYE_DERIVED,
    ],
    sourceUrl:
      'https://www.visaforchina.cn/SYD3_EN/qianzhengyewu/jichuzhishi/changjianwenti/355135188537315328.html',
    lastVerified: '2026-08-07',
  },
  {
    // MOFA publishes a fully dimensioned template: 34+/-2 mm face length,
    // 4+/-2 mm above the crown and 7+/-2 mm below the chin. That chin margin
    // pins the eye line far more tightly than the generic ICAO band, so the
    // eye range here is derived from Japan's own numbers rather than EYE_DERIVED.
    id: 'jp-35x45',
    country: 'Japan',
    countryCode: 'JP',
    documents: ['Passport', 'Visa'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 32, max: 36, default: 34 },
    eye: { min: 23, max: 29, default: 26 },
    headroom: { min: 2, max: 6 },
    background: WHITE_STRICT,
    notes: [
      'Face length 34 +/- 2 mm crown to chin, per the MOFA template.',
      'Crown sits 4 +/- 2 mm below the top edge; chin 7 +/- 2 mm above the bottom.',
      'Taken within the last 6 months, no hat, facing straight ahead.',
      'Plain background with no pattern or shadow; borderless print.',
      'Eye line derived from the published chin margin and face length, not quoted directly.',
    ],
    sourceUrl: 'https://www.mofa.go.jp/mofaj/toko/passport/ic_photo.html',
    lastVerified: '2026-08-07',
  },
  {
    // The APO accepts prints from 35x40 mm up to 45x50 mm; 35x45 is the
    // smallest accepted size and the one modelled here.
    id: 'au-35x45',
    country: 'Australia',
    countryCode: 'AU',
    documents: ['Passport'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 32, max: 36, default: 34 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_TO_GREY,
    notes: [
      'Face measures 32-36 mm from chin to crown.',
      'Prints from 35-40 mm wide by 45-50 mm high are accepted; 35x45 mm is modelled here.',
      'Plain light-coloured background, evenly lit, no shadows behind the head.',
      'Neutral expression, mouth closed, eyes open and clearly visible.',
      EYE_DERIVED,
    ],
    sourceUrl: 'https://www.passports.gov.au/PhotoGuidelines',
    lastVerified: '2026-08-07',
  },
  {
    // The EU does not publish its own millimetre figures - the Visa Code
    // requires ICAO-compliant photographs and member states each republish
    // ICAO's numbers. Hence HEAD_ICAO rather than a quoted national rule.
    id: 'schengen-35x45',
    country: 'Schengen Area (EU)',
    countryCode: 'EU',
    documents: ['Schengen Visa', 'Residence Permit'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 32, max: 36, default: 34 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_TO_GREY,
    notes: [
      'The Visa Code requires an ICAO-compliant photograph rather than an EU-specific size.',
      'No more than 6 months old, in colour, taken against a light plain background.',
      'Neutral expression, mouth closed, looking straight at the camera.',
      'Individual consulates may add their own rules - check the one you apply to.',
      HEAD_ICAO,
      EYE_DERIVED,
    ],
    sourceUrl:
      'https://home-affairs.ec.europa.eu/policies/schengen/visa-policy/applying-schengen-visa_en',
    lastVerified: '2026-08-07',
  },
  {
    // The MEA instruction booklet specifies size and background but no head
    // height, so the head range follows ICAO.
    id: 'in-35x45',
    country: 'India',
    countryCode: 'IN',
    documents: ['Passport', 'Visa', 'OCI'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 32, max: 36, default: 34 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_STRICT,
    notes: [
      'Passport Seva requires 4.5 x 3.5 cm colour photographs on a white background.',
      'Face centred and facing the camera, with both edges of the face visible.',
      'Neutral expression, eyes open, no reflections on glasses.',
      HEAD_ICAO,
      EYE_DERIVED,
    ],
    sourceUrl:
      'https://www.passportindia.gov.in/AppOnlineProject/pdf/ApplicationformInstructionBooklet-V3.0.pdf',
    lastVerified: '2026-08-07',
  },
  {
    // Brazil publishes its head measurement as chin-to-*forehead*, not
    // chin-to-crown; the note says so rather than silently reinterpreting it.
    id: 'br-50x70',
    country: 'Brazil',
    countryCode: 'BR',
    documents: ['Passport'],
    unit: 'mm',
    photoW: 50,
    photoH: 70,
    dpi: 300,
    head: { min: 31, max: 36, default: 33.5 },
    eye: { min: 39, max: 48, default: 44 },
    background: WHITE_STRICT,
    notes: [
      'Published as 31-36 mm from chin to forehead - the source measures to the forehead, not the crown.',
      'Colour 5 x 7 cm photo on a white background, face and shoulders fully framed.',
      'No reflections, glare or shadows anywhere in the frame.',
      'Neutral expression with eyes open and visible; nothing covering the face.',
      EYE_DERIVED,
    ],
    sourceUrl:
      'https://www.gov.br/mre/pt-br/embaixada-sao-jose/consular/especificacoes-da-fotografia-para-o-pedido-de-passaporte',
    lastVerified: '2026-08-07',
  },
  {
    // SRE publishes size, background and a notably short 30-day recency rule,
    // but no head height.
    id: 'mx-35x45',
    country: 'Mexico',
    countryCode: 'MX',
    documents: ['Passport'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 32, max: 36, default: 34 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_STRICT,
    notes: [
      'Passport size 4.5 x 3.5 cm, in colour on a white background.',
      'Taken no more than 30 days before the appointment - the strictest recency rule here.',
      'Face forward, head uncovered, no glasses.',
      'No digital, scanned or retouched photographs are accepted.',
      HEAD_ICAO,
      EYE_DERIVED,
    ],
    sourceUrl: 'https://sre.gob.mx/tramites-y-servicios/pasaportes',
    lastVerified: '2026-08-07',
  },
  {
    id: 'pk-35x45',
    country: 'Pakistan',
    countryCode: 'PK',
    documents: ['Passport', 'Visa'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 32, max: 36, default: 34 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_STRICT,
    notes: [
      'DGIP requires 45 mm high by 35 mm wide, professionally taken.',
      'Must not be cropped down from a larger picture.',
      'No editing in Photoshop or any other software.',
      HEAD_ICAO,
      EYE_DERIVED,
    ],
    sourceUrl: 'https://onlinemrp.dgip.gov.pk/photo-requirements/',
    lastVerified: '2026-08-07',
  },
  {
    // For the e-passport the photo is captured at the enrolment centre; the
    // published 45x35 mm size applies to visa and paper applications.
    id: 'bd-35x45',
    country: 'Bangladesh',
    countryCode: 'BD',
    documents: ['Visa', 'Passport'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 32, max: 36, default: 34 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_STRICT,
    notes: [
      'DIP requires a 45 x 35 mm colour photograph on a white background.',
      'For the e-passport itself the photo is captured at the enrolment centre.',
      'Face the camera directly with a neutral expression and both eyes open.',
      HEAD_ICAO,
      EYE_DERIVED,
    ],
    sourceUrl: 'https://dip.gov.bd/site/page/62d723a9-5b7b-4b00-b449-cb2e263eb22f/-',
    lastVerified: '2026-08-07',
  },
  {
    // MOFA Korea is unusually explicit that the crown is measured excluding
    // hair volume, which is the single most common cause of rejection there.
    id: 'kr-35x45',
    country: 'South Korea',
    countryCode: 'KR',
    documents: ['Passport'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 32, max: 36, default: 34 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_STRICT,
    notes: [
      'Head length 3.2-3.6 cm measured from the crown to the chin.',
      'The crown is the top of the head excluding hair - volume and tied-up hair do not count.',
      'Colour photo taken within the last 6 months, front-facing, no hat.',
      'Online applications recommend a 413 x 531 pixel file.',
      EYE_DERIVED,
    ],
    sourceUrl: 'https://www.passport.go.kr/home/kor/contents.do?menuPos=32',
    lastVerified: '2026-08-07',
  },
  {
    // ICA publishes a notably wide face range (25-35 mm) - smaller heads are
    // accepted here than under the ICAO 32-36 mm band.
    id: 'sg-35x45',
    country: 'Singapore',
    countryCode: 'SG',
    documents: ['Passport', 'Citizenship', 'Long-Term Pass'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 25, max: 35, default: 32 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_STRICT,
    notes: [
      'Facial image 25-35 mm from chin to crown - a wider band than ICAO.',
      'Plain white background; prints must be matt or semi-matt, not glossy.',
      'Taken within the last 3 months; the top of the shoulders must be visible.',
      'Digital uploads are 400 x 514 pixels; no editing or enhancement of any kind.',
      EYE_DERIVED,
    ],
    sourceUrl: 'https://www.ica.gov.sg/photo-guidelines',
    lastVerified: '2026-08-07',
  },
  {
    id: 'ph-35x45',
    country: 'Philippines',
    countryCode: 'PH',
    documents: ['Passport', 'Visa'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 32, max: 36, default: 34 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_STRICT,
    notes: [
      'DFA requires 4.5 x 3.5 cm colour photographs on a white background.',
      'Taken within the last 6 months, full front view of the face.',
      'At DFA consular offices the passport photo is captured on site instead.',
      HEAD_ICAO,
      EYE_DERIVED,
    ],
    sourceUrl:
      'https://ottawape.dfa.gov.ph/index.php/2016-04-12-08-36-34/2016-04-13-03-10-46/passports',
    lastVerified: '2026-08-07',
  },
  {
    // Indonesia's published visa photo is the local 4x6 cm "pas foto". No head
    // geometry is published, so the head band is the ICAO proportion (71-80%
    // of frame height) scaled to a 60 mm frame - flagged in the notes.
    id: 'id-40x60',
    country: 'Indonesia',
    countryCode: 'ID',
    documents: ['Visa', 'Stay Permit'],
    unit: 'mm',
    photoW: 40,
    photoH: 60,
    dpi: 300,
    head: { min: 43, max: 48, default: 45 },
    eye: { min: 34, max: 41, default: 37.5 },
    background: WHITE_STRICT,
    notes: [
      'Directorate General of Immigration requires a 4 x 6 cm colour photo on a solid white background.',
      'Taken within the last 6 months and not digitally edited.',
      'Neutral expression - a smile must not show the teeth; no glasses, hat or contact lenses.',
      'Hair must not cover the ears or eyes; avoid white clothing against the white backdrop.',
      'No head height is published; this band is the ICAO 32-36 mm-in-45 mm proportion scaled to the 60 mm frame, not an Indonesian rule.',
      EYE_DERIVED,
    ],
    sourceUrl:
      'https://www.imigrasi.go.id/faq/visa/apa-saja-dokumen-persyaratan-untuk-mengajukan-visa-online',
    lastVerified: '2026-08-07',
  },
  {
    // Turkey uses a 50x60 mm biometric photo - the largest frame in this
    // registry - but publishes no head height, only ICAO conformance.
    id: 'tr-50x60',
    country: 'Turkey',
    countryCode: 'TR',
    documents: ['Passport', 'ID Card', 'Residence Permit'],
    unit: 'mm',
    photoW: 50,
    photoH: 60,
    dpi: 300,
    head: { min: 43, max: 48, default: 45 },
    eye: { min: 34, max: 41, default: 37.5 },
    background: WHITE_STRICT,
    notes: [
      'Biometric photo is 50 x 60 mm on a plain white, patternless background.',
      'Taken within the last 6 months, with no shadows cast on the background.',
      'Even lighting, no red-eye, no reflection or tint on spectacle lenses.',
      'Frames must not be thick enough to cover the eyes; no hats or headwear.',
      'No head height is published; this band is the ICAO 32-36 mm-in-45 mm proportion scaled to the 60 mm frame, not a Turkish rule.',
      EYE_DERIVED,
    ],
    sourceUrl: 'https://www.nvi.gov.tr/istanbul/biyometrik-fotograf-nasil-olmalidir',
    lastVerified: '2026-08-07',
  },
  {
    // The MVD regulation is unusually complete: head height, head width and a
    // 5(+/-1) mm margin above the crown are all published, so the eye line is
    // derived from Russia's own figures rather than the generic band.
    id: 'ru-35x45',
    country: 'Russia',
    countryCode: 'RU',
    documents: ['Passport', 'International Passport'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 30, max: 32, default: 31 },
    eye: { min: 23, max: 29, default: 26 },
    headroom: { min: 4, max: 6 },
    background: WHITE_TO_GREY,
    notes: [
      'Head 30-32 mm high and 18-22 mm wide; the face fills 70-80% of the frame.',
      'Free margin above the head is 5 (+/-1) mm.',
      'Face and the upper part of the shoulders must both be in frame.',
      'Headwear allowed on religious grounds if it does not hide the oval of the face.',
      'No uniform or outerwear, no scarves covering the chin, no retouching.',
      'Eye line derived from the published head height and top margin, not quoted directly.',
    ],
    sourceUrl:
      'https://xn--b1aew.xn--p1ai/mvd/structure1/Glavnie_upravlenija/guvm/news/item/63579302/',
    lastVerified: '2026-08-07',
  },
  {
    id: 'ae-35x45',
    country: 'United Arab Emirates',
    countryCode: 'AE',
    documents: ['Emirates ID', 'Visa', 'Passport'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 32, max: 36, default: 34 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_STRICT,
    notes: [
      'ICP requires a 4.5 x 3.5 cm personal photo on a white background.',
      'Must conform to ICAO specifications and be recent.',
      'Eyes open; hands must not appear above shoulder level; no border or frame.',
      HEAD_ICAO,
      EYE_DERIVED,
    ],
    sourceUrl: 'https://icp.gov.ae/wp-content/uploads/2021/11/icao_english.pdf',
    lastVerified: '2026-08-07',
  },
  {
    // Saudi Arabia publishes the head size as a proportion - "the face must
    // present 60% to 70% of the photo" - converted here against the 60 mm
    // height to 36-42 mm.
    id: 'sa-40x60',
    country: 'Saudi Arabia',
    countryCode: 'SA',
    documents: ['Visa'],
    unit: 'mm',
    photoW: 40,
    photoH: 60,
    dpi: 300,
    head: { min: 36, max: 42, default: 39 },
    eye: { min: 34, max: 41, default: 37.5 },
    background: WHITE_STRICT,
    notes: [
      'Published rule is "the face must present 60% to 70% of the photo"; against the 60 mm height that is 36-42 mm.',
      'Photo is 4 x 6 cm on a white background, with no exceptions on the background.',
      'Full-face view facing the camera directly, taken within the last 6 months.',
      'Attach with tape, a paper clip or a single staple - never glue, never over the face.',
      EYE_DERIVED,
    ],
    sourceUrl:
      'https://embassies.mofa.gov.sa/sites/usa/EN/CONSULARANDTRAVELSERVICES/VISAAPPLICATION/Pages/Guideline-accepted-photographs-saudi-visas.aspx',
    lastVerified: '2026-08-07',
  },
  {
    id: 'nz-35x45',
    country: 'New Zealand',
    countryCode: 'NZ',
    documents: ['Passport'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 32, max: 36, default: 34 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_TO_GREY,
    notes: [
      'Printed photos for a paper application are 35 mm wide by 45 mm high.',
      'Leave a clear gap around the sides and top of the head; include shoulders and upper chest.',
      'Colour photo taken within the last 6 months - selfies are not accepted.',
      HEAD_ICAO,
      EYE_DERIVED,
    ],
    sourceUrl: 'https://www.passports.govt.nz/passport-photos',
    lastVerified: '2026-08-07',
  },
  {
    // Malaysia uses a 35x50 mm frame and publishes the head size both in mm
    // and as a proportion (25-30 mm, stated as 50-60% of the photo).
    id: 'my-35x50',
    country: 'Malaysia',
    countryCode: 'MY',
    documents: ['Passport'],
    unit: 'mm',
    photoW: 35,
    photoH: 50,
    dpi: 300,
    head: { min: 25, max: 30, default: 27.5 },
    eye: { min: 28, max: 34, default: 31 },
    background: WHITE_STRICT,
    notes: [
      'Photo is 35 x 50 mm on a shadowless white background.',
      'Face measures 25-30 mm chin to crown, published as 50-60% of the photo space.',
      'The full face from chin to crown must be visible, with no headgear.',
      'Scanned photos and selfies are not accepted.',
      EYE_DERIVED,
    ],
    sourceUrl:
      'https://www.imi.gov.my/index.php/en/main-services/passport/malaysian-international-passport/',
    lastVerified: '2026-08-07',
  },
  {
    id: 'vn-40x60',
    country: 'Vietnam',
    countryCode: 'VN',
    documents: ['Visa', 'e-Visa'],
    unit: 'mm',
    photoW: 40,
    photoH: 60,
    dpi: 300,
    head: { min: 43, max: 48, default: 45 },
    eye: { min: 34, max: 41, default: 37.5 },
    background: WHITE_STRICT,
    notes: [
      'Portrait photo is 4 x 6 cm on a white background.',
      'Look straight ahead at the camera; glasses must be removed.',
      'Same size applies to e-Visa uploads and paper visa applications.',
      'No head height is published; this band is the ICAO 32-36 mm-in-45 mm proportion scaled to the 60 mm frame, not a Vietnamese rule.',
      EYE_DERIVED,
    ],
    sourceUrl: 'https://evisa.gov.vn/instruction',
    lastVerified: '2026-08-07',
  },
  {
    // Kenya is the only square non-US format here: 5.5 x 5.5 cm, with the head
    // size published as a proportion (70-80% of the photo) rather than in mm.
    id: 'ke-55x55',
    country: 'Kenya',
    countryCode: 'KE',
    documents: ['Passport', 'Visa', 'ID'],
    unit: 'mm',
    photoW: 55,
    photoH: 55,
    dpi: 300,
    head: { min: 38.5, max: 44, default: 41 },
    eye: { min: 31, max: 38, default: 34 },
    background: WHITE_STRICT,
    notes: [
      'Photo is 5.5 x 5.5 cm in colour on a white background.',
      'Published rule is that the face fills 70-80% of the photo; against 55 mm that is 38.5-44 mm.',
      'Close-up of the head and the top of the shoulders, looking straight at the camera.',
      'No more than 6 months old; scanned images and colour photocopies are rejected.',
      'No headgear except on religious grounds, and the forehead must stay uncovered.',
      EYE_DERIVED,
    ],
    sourceUrl: 'https://immigration.ecitizen.go.ke/index.php?id=9',
    lastVerified: '2026-08-07',
  },
  {
    // South Africa publishes both the mm range and the 70-80% proportion, and
    // the two agree: 29-34 mm is roughly 65-75% of a 45 mm frame.
    id: 'za-35x45',
    country: 'South Africa',
    countryCode: 'ZA',
    documents: ['Passport', 'ID'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 29, max: 34, default: 31.5 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_STRICT,
    notes: [
      'Photo is 35 x 45 mm with the head measuring 29-34 mm from crown to chin.',
      'Close-up of head and top of shoulders so the face fills 70-80% of the frame.',
      'White background, mouth closed, uniform lighting with no shadows or flash reflection.',
      'Two colour photographs are required unless applying at a smartcard office.',
      EYE_DERIVED,
    ],
    sourceUrl:
      'https://dirco.gov.za/japan/wp-content/uploads/sites/59/2024/08/Photograph-specifications-for-passports.pdf',
    lastVerified: '2026-08-07',
  },
  {
    // The MFA visa application form states the size and recency but not a
    // background colour, so the permissive white-to-grey rule is used.
    id: 'th-35x45',
    country: 'Thailand',
    countryCode: 'TH',
    documents: ['Visa'],
    unit: 'mm',
    photoW: 35,
    photoH: 45,
    dpi: 300,
    head: { min: 32, max: 36, default: 34 },
    eye: { min: 25, max: 31, default: 28 },
    background: WHITE_TO_GREY,
    notes: [
      'The MFA visa application form requires a 3.5 x 4.5 cm front-view photograph.',
      'Taken within the last 6 months.',
      'The form does not state a background colour; a plain light background is the consular norm.',
      HEAD_ICAO,
      EYE_DERIVED,
    ],
    sourceUrl: 'https://image.mfa.go.th/mfa/0/2QL32ZatFo/Visa_application.pdf',
    lastVerified: '2026-08-07',
  },
  {
    // RENAPER Disposicion 904/2021 fixes a 4x4 cm square "medio busto" frame -
    // a wider crop than the ICAO head-and-shoulders token image. Because the
    // ICAO 45 mm proportions do not transfer to it, the head and eye bands
    // here follow the US 2x2 square-format geometry instead. Both are flagged.
    id: 'ar-40x40',
    country: 'Argentina',
    countryCode: 'AR',
    documents: ['Passport', 'DNI'],
    unit: 'mm',
    photoW: 40,
    photoH: 40,
    dpi: 300,
    head: { min: 20, max: 27.5, default: 24 },
    eye: { min: 22.5, max: 27.5, default: 25 },
    background: WHITE_STRICT,
    notes: [
      'RENAPER requires a 4 x 4 cm colour photo, front-facing, half-bust, on a plain uniform white background.',
      'Head completely uncovered, eyes open, no third-party hands holding the subject.',
      'No alteration or falsification of facial features.',
      'Hair may be covered on religious or medical grounds if the main facial features stay visible.',
      'No head height is published; the band shown transfers the US square-format proportions (head 50-69% of frame height) to the 40 mm frame, not an Argentine rule.',
      EYE_DERIVED,
    ],
    sourceUrl: 'https://www.argentina.gob.ar/normativa/nacional/norma-357260/actualizacion',
    lastVerified: '2026-08-07',
  },
]
