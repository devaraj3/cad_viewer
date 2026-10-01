import type { BlankMaterial } from "./blank-report";

/**
 * Reference sheet prices per kg, by region and material - stockist /
 * service-centre sheet (not mill, not tiny retail cuts), EXCLUDING tax
 * (GST / VAT / sales tax). Approximate and for estimating only.
 *
 * `basis`:
 *  - "sourced": taken (or computed per kg from price / sheet weight) from the
 *    dated source(s) listed.
 *  - "derived": no usable dealer price found; estimated from a dated market
 *    index (LME / MCX / COMEX / CRC coil) x a sheet-processing multiplier
 *    observed on the sourced rows. Lower confidence.
 *
 */
export const PRICES_AS_OF = "2026-10-01";

export type RegionId = "IN" | "US" | "EU" | "UK";
export type RegionInfo = { id: RegionId; label: string; currency: "INR" | "USD" | "EUR" | "GBP" };

export const REGIONS: RegionInfo[] = [
  { id: "IN", label: "India", currency: "INR" },
  { id: "US", label: "US", currency: "USD" },
  { id: "EU", label: "EU", currency: "EUR" },
  { id: "UK", label: "UK", currency: "GBP" },
];

export type RateSource = { url: string; date: string; note: string };
export type ReferenceRate = {
  pricePerKg: number;
  basis: "sourced" | "derived";
  sources: RateSource[];
};

type MaterialId = BlankMaterial["id"];

export const REFERENCE_RATES: Record<RegionId, Record<MaterialId, ReferenceRate>> = {
  IN: {
    mild_steel: {
      pricePerKg: 60,
      basis: "sourced",
      sources: [
        { url: "https://blog.tatanexarc.com/da/mild-steel-ms-sheet-price/", date: "2026-02-19", note: "CR sheet INR 56-59/kg, 6 cities" },
        { url: "https://dir.indiamart.com/impcat/crc-steel-sheet.html", date: "undated", note: "Bengaluru 1.6mm CR INR 58.5-62/kg (search snippet)" },
      ],
    },
    galvanized_steel: {
      pricePerKg: 78,
      basis: "sourced",
      sources: [
        { url: "https://www.pm-industries.com/gi-sheet-price-list/", date: "2026-07-27", note: "GI 1-2mm INR 51-89/kg, 'indicative'" },
        { url: "https://blog.tatanexarc.com/da/what-is-galvanised-steel/", date: "2026-09", note: "GI INR 65-100/kg (GST status not stated)" },
      ],
    },
    stainless_304: {
      pricePerKg: 225,
      basis: "sourced",
      sources: [
        { url: "https://www.abhaysteels.in/jindal-stainless-steel-sheet-304-price-list.html", date: "2026-06-30", note: "Jindal 304 2B 1.0-4.0mm INR 223.89/kg, ex-yard Mumbai, excl. GST" },
      ],
    },
    aluminium_5052: {
      pricePerKg: 410,
      basis: "derived",
      sources: [
        { url: "https://www.goldpriceindia.com/aluminium-price-india.php", date: "2026-09-29", note: "MCX aluminium INR ~346-356/kg; sheet x ~1.2 (carried from prior research, no fresh 5052 dealer list)" },
      ],
    },
    aluminium_6061: {
      pricePerKg: 430,
      basis: "sourced",
      sources: [
        { url: "https://www.jagdishmetalindia.com/aluminium-6061-sheet-bar-price-list.html", date: "undated", note: "6061 1-6mm INR 430/kg (GST not stated); consistent with MCX spot x 1.2" },
      ],
    },
    copper: {
      pricePerKg: 1600,
      basis: "sourced",
      sources: [
        { url: "https://www.goldpriceindia.com/copper-price-india.php", date: "2026-10-01", note: "copper spot INR 1,404/kg" },
        { url: "https://dir.indiamart.com/impcat/copper-sheet.html", date: "undated", note: "dealer listings INR 1,430-1,775/kg (listings below spot rejected)" },
      ],
    },
    brass: {
      pricePerKg: 1150,
      basis: "derived",
      sources: [
        { url: "https://www.goldpriceindia.com/copper-price-india.php", date: "2026-10-01", note: "63% Cu x INR 1,404 + 37% Zn (assumed ~INR 290) ~ INR 990 metal, x ~1.15 sheet" },
        { url: "https://dir.indiamart.com/impcat/brass-sheet.html", date: "undated", note: "listings INR 425-700 REJECTED: below contained-copper cost at current spot" },
      ],
    },
  },
  US: {
    mild_steel: {
      pricePerKg: 2.5,
      basis: "derived",
      sources: [
        { url: "https://fabcostestimator.com/metal-prices", date: "2026-09-30", note: "A36 plate USD 1.01/lb (index); US CRC coil ~USD 1,446/short ton (Sep 2026) x ~1.5 service-centre sheet" },
      ],
    },
    galvanized_steel: {
      pricePerKg: 2.7,
      basis: "derived",
      sources: [
        { url: "https://www.ryerson.com/metal-resources/metal-market-intelligence/are-steel-prices-coming-down", date: "2026-09", note: "coated steel ~USD 1,551/ton x ~1.5 sheet" },
      ],
    },
    stainless_304: {
      pricePerKg: 7.4,
      basis: "sourced",
      sources: [
        { url: "https://fabcostestimator.com/metal-prices", date: "2026-09-30", note: "304 sheet USD 3.36/lb (index x form multiplier, 'not a quote')" },
        { url: "https://www.mwalloys.com/stainless-steel-prices-per-pound/", date: "2026-09-16", note: "304 USD 3.37/lb" },
      ],
    },
    aluminium_5052: {
      pricePerKg: 8.5,
      basis: "sourced",
      sources: [
        { url: "https://fabcostestimator.com/metal-prices", date: "2026-09-30", note: "5052 sheet USD 3.87/lb" },
        { url: "https://www.mwalloys.com/stainless-steel-prices-per-pound/", date: "2026-09-16", note: "5052 USD 4.00/lb" },
      ],
    },
    aluminium_6061: {
      pricePerKg: 10.1,
      basis: "sourced",
      sources: [
        { url: "https://www.mwalloys.com/stainless-steel-prices-per-pound/", date: "2026-09-16", note: "6061 USD 4.67/lb" },
        { url: "https://fabcostestimator.com/metal-prices", date: "2026-09-30", note: "6061 extrusion USD 4.52/lb" },
      ],
    },
    copper: {
      pricePerKg: 17,
      basis: "derived",
      sources: [
        { url: "https://tradingeconomics.com/commodity/copper", date: "2026-09-30", note: "COMEX USD 6.56/lb (~14.5/kg cathode) x ~1.17 sheet" },
      ],
    },
    brass: {
      pricePerKg: 14,
      basis: "derived",
      sources: [
        { url: "https://tradingeconomics.com/commodity/copper", date: "2026-09-30", note: "70/30 brass: 0.7 Cu + 0.3 Zn (~USD 3/kg) ~ USD 11/kg metal x ~1.3 sheet" },
      ],
    },
  },
  EU: {
    mild_steel: {
      pricePerKg: 2.2,
      basis: "sourced",
      sources: [
        { url: "https://stahlshop.de/feinblech-1mm-kleinformat", date: "2026-10", note: "DC01 1x1000x2000, net EUR 2.10-2.40/kg at 50-400 kg tiers" },
      ],
    },
    galvanized_steel: {
      pricePerKg: 2.6,
      basis: "derived",
      sources: [
        { url: "https://www.eisenfachmarkt.at/produkte/stahlblech-2000x1000x1-dx51d-z275-verzinkt", date: "2026-10", note: "retail EUR 4.20/kg gross (small lot, rejected as retail); set DC01 tier x ~1.2 zinc premium" },
      ],
    },
    stainless_304: {
      pricePerKg: 7.5,
      basis: "sourced",
      sources: [
        { url: "https://webshop.schachermayer.com/cat/de-IT/product/edelstahl-blech-1-4301-iiic-ungeschliffen-2500-1250-3-mm/106829562", date: "2026-10", note: "1.4301 3mm 2500x1250 EUR 7.27/kg net; 1mm EUR 7.54/kg; 2mm 3000x1500 EUR 10.46/kg rejected as outlier" },
      ],
    },
    aluminium_5052: {
      pricePerKg: 9.5,
      basis: "derived",
      sources: [
        { url: "https://www.bleche-onlineshop.de/aluminium-tafeln-blech-natur/", date: "2026-10", note: "1050 5mm 1000x2000 EUR 358.98 gross = ~EUR 11.2/kg net (retail, upper bound); LME USD 3,178/t 30 Sep 2026" },
      ],
    },
    aluminium_6061: {
      pricePerKg: 10.5,
      basis: "derived",
      sources: [
        { url: "https://www.bleche-onlineshop.de/aluminium-tafeln-blech-natur/", date: "2026-10", note: "5052 estimate + ~10% for 6061" },
      ],
    },
    copper: {
      pricePerKg: 18.5,
      basis: "sourced",
      sources: [
        { url: "https://www.boesken.de/klempner/kupferblech/11666/kupfer-blech-staerke-0.60-mm-tafel-2000-x-1000-mm-10-8-kg/tafel", date: "2026-10", note: "0.6mm 2000x1000 10.8kg EUR 199.60 = EUR 18.48/kg (VAT status not stated)" },
      ],
    },
    brass: {
      pricePerKg: 16,
      basis: "derived",
      sources: [
        { url: "https://www.metalxact.com/messingblech-2-mm-cuzn37-hart-ms63/lm-16101-007", date: "2026-10", note: "EUR 570.18/sheet; page weight not verifiable, so set ~0.87 x EU copper sheet" },
      ],
    },
  },
  UK: {
    mild_steel: {
      pricePerKg: 1.47,
      basis: "sourced",
      sources: [
        { url: "https://www.fhbrundle.co.uk/products/30188416__Mild_Steel_CR4_2500mm_x_1250mm_x_1.5mm", date: "2026-10", note: "CR4 DC01 1.5mm 2500x1250, GBP 54.00 ex VAT / 36.8 kg = 1.47/kg (10+ sheets: 1.17)" },
      ],
    },
    galvanized_steel: {
      pricePerKg: 1.75,
      basis: "derived",
      sources: [
        { url: "https://www.fhbrundle.co.uk/products/30188416__Mild_Steel_CR4_2500mm_x_1250mm_x_1.5mm", date: "2026-10", note: "CR4 sheet x ~1.2 zinc premium (no dated UK GI list found)" },
      ],
    },
    stainless_304: {
      pricePerKg: 4.1,
      basis: "sourced",
      sources: [
        { url: "https://steelprices.co.uk/stainless-steel-prices", date: "2026-09-08", note: "304 2B full sheets 2500x1250 GBP 3.70-4.50/kg ex VAT (from Aluminium Warehouse / FH Brundle / Metal Store lists)" },
      ],
    },
    aluminium_5052: {
      pricePerKg: 8.8,
      basis: "sourced",
      sources: [
        { url: "https://www.aluminiumwarehouse.co.uk/products/2500-mm-x-1250-mm-x-2-0-mm-5251-h22-aluminium-sheet", date: "2026-10", note: "5251 H22 2mm 2500x1250 GBP 149.38 ex VAT / 16.9 kg = 8.84/kg (5251 used as the UK 5052 equivalent; single-sheet price, likely high)" },
      ],
    },
    aluminium_6061: {
      pricePerKg: 9.5,
      basis: "derived",
      sources: [
        { url: "https://www.aluminiumwarehouse.co.uk/products/2500-mm-x-1250-mm-x-2-0-mm-5251-h22-aluminium-sheet", date: "2026-10", note: "5251 sheet price + ~8% for 6061" },
      ],
    },
    copper: {
      pricePerKg: 13.5,
      basis: "derived",
      sources: [
        { url: "https://www.lme.com/metals/non-ferrous/lme-copper", date: "2026-09-30", note: "LME copper USD 14,438/t (~GBP 10.8/kg) x ~1.25 sheet; UK dealers (Durbin, S&D) publish no prices" },
      ],
    },
    brass: {
      pricePerKg: 9.5,
      basis: "derived",
      sources: [
        { url: "https://www.lme.com/metals/non-ferrous/lme-copper", date: "2026-09-30", note: "~0.7 x UK copper sheet; UK dealers publish no brass sheet prices" },
      ],
    },
  },
};

const EU_TIMEZONE_PREFIXES = ["Europe/"];
const EU_LOCALE_REGIONS = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT",
  "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "NO", "CH",
]);

/** Best-guess region from the browser locale (country subtag), falling back to timezone. */
export function detectRegion(locale?: string, timeZone?: string): RegionId {
  const country = locale?.split(/[-_]/)[1]?.toUpperCase();
  if (country === "IN") return "IN";
  if (country === "US") return "US";
  if (country === "GB") return "UK";
  if (country && EU_LOCALE_REGIONS.has(country)) return "EU";
  if (timeZone?.startsWith("Asia/Kolkata") || timeZone?.startsWith("Asia/Calcutta")) return "IN";
  if (timeZone === "Europe/London") return "UK";
  if (timeZone && EU_TIMEZONE_PREFIXES.some((p) => timeZone.startsWith(p))) return "EU";
  if (timeZone?.startsWith("America/")) return "US";
  return "US";
}

/** "Oct 2026" from PRICES_AS_OF. */
export function pricesAsOfLabel(): string {
  const [y, m] = PRICES_AS_OF.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}
