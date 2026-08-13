# Privacy Policy — CDAC AnuvaadMitra

**Effective date:** [DD Month 2026] · **Last updated:** [DD Month 2026]

CDAC AnuvaadMitra ("the Extension") is a browser extension published by the
Centre for Development of Advanced Computing (C-DAC). It lets you select English
text on a web page and receive a Hindi (or Hinglish) translation. This policy
explains what information the Extension processes, why, and the choices you have.

> **In short:** the Extension processes only the text you explicitly choose to
> translate, plus your local settings. It does not collect your browsing history,
> does not build a profile of you, does not show ads, and does not sell your data.

## 1. Who we are

The Extension is developed and published by C-DAC. For any privacy question or
request relating to the Extension, contact us at **[anuvaadmitra-support@cdac.in]**.

## 2. What the Extension does

When you select English text and activate the Extension (by clicking its in-page
button or using the right-click menu), the selected text is sent to a translation
service to produce a Hindi or Hinglish translation, which is then shown to you on
the page so you can copy it. The Extension offers three translation engines —
C-DAC Pune, Bhashini (Government of India), and Google Translate — with an
automatic fallback option if your chosen engine is unavailable.

The Extension also offers an optional transliteration helper that suggests
Devanagari spellings for a word typed phonetically in Roman script; when you use
it, that single word is sent to the Bhashini transliteration service via the same
route described below.

## 3. Information the Extension processes

### a. Text you choose to translate

The only content the Extension transmits is the text you actively select and
submit for translation (or the word you type for a transliteration suggestion).
It does not read, collect, or transmit page content you have not selected. This
text is sent only to fulfil your translation request and is not stored by the
Extension.

### b. Your settings

Your preferences — chosen translation engine, the automatic-fallback toggle, and
an optional custom translation-server URL — are saved using Chrome's
`storage.sync` so they persist and follow your Chrome profile across devices.
These settings contain no personal information and are not transmitted to us for
any purpose other than making the Extension work.

### c. How requests reach the translation engines

Requests to the C-DAC Pune and Bhashini engines are routed through a proxy server
operated by C-DAC. The proxy forwards your selected text to the relevant engine
and returns the translation. The proxy holds the API credentials so they are
never exposed in the Extension. In the course of handling a request the proxy
processes your network (IP) address transiently for security and abuse-prevention
(rate limiting); it does not use this to identify you or build a profile. Requests
to Google Translate are made directly from your browser to Google.

## 4. What we do NOT collect

- We do not collect your browsing history or the pages you visit.
- We do not collect names, email addresses, or other personal identifiers.
- We do not use analytics, tracking pixels, or advertising.
- We do not sell or rent any data to anyone.
- We do not transmit any page content other than the text you select.

## 5. Third-party translation services

To produce a translation, the text you submit is processed by the translation
engine you have selected (or, in Auto mode, by the engines in turn until one
succeeds). Each service handles data under its own terms and privacy policy:

| Service | Operator | Privacy policy |
|---|---|---|
| C-DAC Pune translation | C-DAC | https://www.cdac.in |
| Bhashini | Digital India Bhashini Division, MeitY, Government of India | https://bhashini.gov.in/privacy-policy |
| Google Translate | Google LLC | https://policies.google.com/privacy |

Because your selected text is sent to the engine you choose, please avoid
submitting sensitive personal information you would not want processed by a
third-party translation service.

## 6. Data retention

The Extension does not retain the text you translate; it is held only in memory
long enough to display the result. The C-DAC proxy does not persist translated
text; operational logs, if any, are limited to what is needed for security and
reliability and are retained no longer than necessary for those purposes. Your
settings remain in your own Chrome profile until you change them or remove the
Extension.

## 7. Permissions and why they are needed

| Permission | Why the Extension requests it |
|---|---|
| `storage` | To save your engine choice and settings. |
| `contextMenus` | To add the right-click "Translate to Hindi / Hinglish" option. |
| Host access to translation endpoints | To send your selected text to the C-DAC proxy and to Google Translate to obtain a translation. |
| Content script on pages (`<all_urls>`, all frames) | Translation must work on any page you are reading, including text inside embedded frames (for example webmail compose windows). This access is used solely to detect your text selection and to display the translation; the Extension does not read or transmit page content you have not selected. |

## 8. Children's privacy

The Extension is a general-purpose translation tool and is not directed at
children. It does not knowingly collect personal information from anyone,
including children.

## 9. Security

Translation requests are transmitted over HTTPS. API credentials are held on a
C-DAC-controlled server and are never included in the Extension itself.

## 10. Changes to this policy

We may update this policy to reflect changes to the Extension or legal
requirements. Material changes will be reflected by an updated effective date at
the top of this page.

## 11. Contact

Questions or requests regarding this policy or your data can be sent to
**[anuvaadmitra-support@cdac.in]**.

---

CDAC AnuvaadMitra · Published by C-DAC · This privacy policy applies to the CDAC
AnuvaadMitra browser extension distributed via the Chrome Web Store.
