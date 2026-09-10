#!/usr/bin/env node

/*
 * Unit tests for the scoring in apps/sandbox-backend/src/seniorsirkel.ts.
 *
 * Neither a stack, nor a port, nor a model: the module takes the catalogue as a
 * parameter, so every outcome can be pinned against the fixture and a couple of
 * literal aktiviteter.
 *
 * What the fixture can carry, and what it cannot:
 *
 *  1. data/senioraktiviteter.seed.json is *generated as a selection* from the real
 *     catalogue, so it cannot drift out of shape with the schema. Its three tilbud
 *     happen to cover all three tilgjengelighet states - true/true, false/false and
 *     omitted - which is exactly the split the hard filter turns on. pnpm test keeps
 *     that split alive in the catalogue; this file is what reads it.
 *  2. It cannot carry a målgruppe with an upper age bound, or one that gjelderAlle,
 *     because the real catalogue has neither. Those two branches are reached with
 *     literal fixtures - the same reason test-vilkaar.ts carries single-bound
 *     ordninger the seed can never produce.
 *
 * The load-bearing assertion is not any single score. It is that the score is the
 * sum of the weights of the codes that fired, checked over every row of every run:
 * a number written by hand somewhere else in the module would break it.
 *
 * Bruk:
 *   node scripts/test-seniorsirkel.ts
 */

import { readFile } from "node:fs/promises";
import { parseAktivitetskatalog } from "../apps/shared/senioraktivitet.ts";
import type { Aktivitetskatalog, Seniortilbud } from "../apps/shared/senioraktivitet.ts";
import {
  BEGRUNNELSESKODER,
  byggSeniorprofil,
  erHardtKrav,
  parseInteressegrupper,
  rangerTilbud,
  scoreTilbud,
  vektFor
} from "../apps/sandbox-backend/src/seniorsirkel.ts";
import type { Begrunnelseskode, Seniorprofil } from "../apps/sandbox-backend/src/seniorsirkel.ts";
import { feilmelding } from "../apps/shared/errors.ts";

let bestatt = 0;
const feil: string[] = [];

function check(navn: string, betingelse: unknown, detalj = ""): void {
  if (betingelse) { bestatt += 1; return; }
  feil.push(`${navn}${detalj ? ` - ${detalj}` : ""}`);
}

function kaster(navn: string, handling: () => unknown, biten: string): void {
  try {
    handling();
    feil.push(`${navn} - kastet ikke`);
  } catch (e) {
    check(navn, feilmelding(e).includes(biten), feilmelding(e));
  }
}

const les = async (sti: string) => JSON.parse(await readFile(sti, "utf8"));

const katalog: Aktivitetskatalog = parseAktivitetskatalog(
  await les("data/senioraktiviteter.seed.json"));
const grupper = parseInteressegrupper(await les("data/seniorsirkel-grupper.json"));

// Fixturen er et utvalg, ikke en håndskrevet fil. Bommer den, er det katalogen
// som har flyttet seg, og da er resten av påstandene her om noe annet enn de tror.
check("fixturen har tre aktiviteter", katalog.aktiviteter.length === 3,
  String(katalog.aktiviteter.length));
check("fixturen gjelder Ringerike", katalog.kommunenummer === "3305", katalog.kommunenummer);

const RINGERIKE = "3305";
const finn = (id: string) => {
  const aktivitet = katalog.aktiviteter.find((a) => a.aktivitetId === id);
  if (!aktivitet) throw new Error(`fixturen mangler ${id}`);
  return aktivitet;
};
const TUR = finn("lavterskel-turgruppe");     // friluft, rullestol false, teleslynge false
const KINO = finn("seniorkino");              // kultur, rullestol true, teleslynge true
const SPISEVENN = finn("spisevenn");          // frivillig, tilgjengelighet utelatt

function profil(over: Partial<Seniorprofil> = {}): Seniorprofil {
  return { kommunenummer: RINGERIKE, interesser: [], kategorier: [], ...over };
}

// --- 1. byggSeniorprofil ----------------------------------------------------

const p70 = byggSeniorprofil({
  kommunenummer: RINGERIKE,
  foedselsdato: "1956-03-04",
  referansedato: "2026-08-01",
  interesser: ["friluft"]
}, grupper);
check("alderen regnes mot referansedatoen", p70.alder === 70, String(p70.alder));
check("gruppen løses opp i kommunens kategorier",
  p70.kategorier.join(",") === "friluftsliv-og-trening,helse-og-trening",
  p70.kategorier.join(","));

/*
 * Alderen er `alderVed` mot satsenes dato, ikke mot dagen i dag. Bursdagen som
 * ikke er passert er den ene grensen som avgjør hvem som kvalifiserer i det hele
 * tatt, og en implementasjon som leste maskinens klokke ville svart forskjellig
 * på hver side av et årsskifte - se datoavsnittet i AGENTS.md.
 */
const foedt = "1964-08-01";
check("bursdagen er passert på selve dagen",
  byggSeniorprofil({ kommunenummer: RINGERIKE, foedselsdato: foedt, referansedato: "2026-08-01" },
    grupper).alder === 62);
check("bursdagen er ikke passert dagen før",
  byggSeniorprofil({ kommunenummer: RINGERIKE, foedselsdato: foedt, referansedato: "2026-07-31" },
    grupper).alder === 61);
check("uten fødselsdato er alderen ikke oppgitt",
  byggSeniorprofil({ kommunenummer: RINGERIKE }, grupper).alder === undefined);

// To grupper som deler en kategori skal gi den én gang. `moeteplasser` og
// `kultur` deler begge kultur-og-fellesskap.
const pDelt = byggSeniorprofil(
  { kommunenummer: RINGERIKE, interesser: ["moeteplasser", "kultur", "moeteplasser"] }, grupper);
check("en kategori to grupper deler telles én gang",
  pDelt.kategorier.filter((k) => k === "kultur-og-fellesskap").length === 1,
  pDelt.kategorier.join(","));
check("den samme gruppen to ganger blir stående én gang",
  pDelt.interesser.join(",") === "moeteplasser,kultur", pDelt.interesser.join(","));

kaster("en ukjent gruppeverdi kastes framfor å bli ignorert",
  () => byggSeniorprofil({ kommunenummer: RINGERIKE, interesser: ["frilufft"] }, grupper),
  "finnes ikke");
kaster("et kommunenummer som ikke er fire siffer kastes",
  () => byggSeniorprofil({ kommunenummer: "330" }, grupper), "fire siffer");
kaster("en gruppe uten kategorier kastes",
  () => parseInteressegrupper({ grupper: [{ verdi: "tom", label: "Tom", kategorier: [] }] }),
  "valgmulighet uten innhold");

// --- 2. Interesse og målgruppe ----------------------------------------------

const friluft = profil({ alder: 70, interesser: ["friluft"], kategorier: ["friluftsliv-og-trening"] });
check("kategorien i en valgt gruppe gir treff",
  scoreTilbud(friluft, TUR, TUR.tilbud[0]!).begrunnelseskoder.includes("treffer_interesse"));
check("en kategori utenfor gruppene sies, framfor å tie",
  scoreTilbud(friluft, KINO, KINO.tilbud[0]!).begrunnelseskoder.includes("utenfor_interessene"));

// Ingen valgte interesser er ikke det samme som å bomme på alle.
const uspurt = scoreTilbud(profil({ alder: 70 }), KINO, KINO.tilbud[0]!);
check("uten valgte interesser sies ingenting om interesser",
  !uspurt.begrunnelseskoder.includes("treffer_interesse")
  && !uspurt.begrunnelseskoder.includes("utenfor_interessene"),
  uspurt.begrunnelseskoder.join(","));

check("alderen over målgruppens nedre grense treffer",
  scoreTilbud(profil({ alder: 70 }), TUR, TUR.tilbud[0]!)
    .begrunnelseskoder.includes("i_maalgruppen"));
check("alderen under nedre grense står utenfor",
  scoreTilbud(profil({ alder: 55 }), TUR, TUR.tilbud[0]!)
    .begrunnelseskoder.includes("utenfor_maalgruppen"));

/*
 * Ukjent er ikke bom, og det er hele grunnen til at koden finnes. Spisevenn har
 * en målgruppe som bare peker ut et kriterium - «har behov for sosial kontakt» -
 * og profilen bærer ikke behov. En skåring som leste det som «utenfor» ville
 * skjult et tilbud for den som trenger det mest.
 */
check("en målgruppe vi ikke kan måle er ukjent, ikke bom",
  scoreTilbud(profil({ alder: 70 }), SPISEVENN, SPISEVENN.tilbud[0]!)
    .begrunnelseskoder.includes("maalgruppe_ukjent"));
check("uten alder er en aldersmålgruppe ukjent, ikke bom",
  scoreTilbud(profil(), TUR, TUR.tilbud[0]!)
    .begrunnelseskoder.includes("maalgruppe_ukjent"));

/*
 * De to grenene fixturen ikke kan nå. Katalogen har ingen øvre aldersgrense og
 * ingen målgruppe som gjelder alle, så uten literalene under er begge død kode
 * så langt noen test vet.
 */
function medMaalgrupper(maalgrupper: Seniortilbud["maalgrupper"]): Seniortilbud {
  return { ...KINO, maalgrupper };
}
const medTak = medMaalgrupper([
  { maalgruppeId: "under-70", gjelderAlle: false, alder: { fraAar: 62, tilAar: 69 }, kriterier: [] }
]);
check("øvre aldersgrense stenger utenfor",
  scoreTilbud(profil({ alder: 70 }), medTak, medTak.tilbud[0]!)
    .begrunnelseskoder.includes("utenfor_maalgruppen"));
check("øvre aldersgrense er inklusiv",
  scoreTilbud(profil({ alder: 69 }), medTak, medTak.tilbud[0]!)
    .begrunnelseskoder.includes("i_maalgruppen"));
const alle = medMaalgrupper([{ maalgruppeId: "alle", gjelderAlle: true, kriterier: [] }]);
check("en målgruppe som gjelder alle gir poeng, men mindre enn et treff",
  scoreTilbud(profil({ alder: 70 }), alle, alle.tilbud[0]!).score === vektFor("gjelder_alle")
  && vektFor("gjelder_alle") < vektFor("i_maalgruppen"));

// Den beste av flere målgrupper vinner, uansett rekkefølge i filen.
const toVeier = medMaalgrupper([
  { maalgruppeId: "smal", gjelderAlle: false, alder: { fraAar: 90 }, kriterier: [] },
  { maalgruppeId: "vid", gjelderAlle: false, alder: { fraAar: 60 }, kriterier: [] }
]);
const toVeierOmvendt = medMaalgrupper([...toVeier.maalgrupper].reverse());
// Begge rekkefølgene, fordi bare den ene av dem faller for «siste vinner».
for (const [navn, aktivitet] of [["den smale først", toVeier],
  ["den vide først", toVeierOmvendt]] as const) {
  check(`den beste målgruppen avgjør, ikke posisjonen (${navn})`,
    scoreTilbud(profil({ alder: 70 }), aktivitet, aktivitet.tilbud[0]!)
      .begrunnelseskoder.includes("i_maalgruppen"));
}

// --- 3. Tilgjengelighet, i tre tilstander -----------------------------------

const rullestol = profil({ alder: 70, trengerRullestoladkomst: true });
check("rullestol false utelukker når behovet er oppgitt",
  scoreTilbud(rullestol, TUR, TUR.tilbud[0]!).score === null);
check("rullestol true gir poeng",
  scoreTilbud(rullestol, KINO, KINO.tilbud[0]!)
    .begrunnelseskoder.includes("rullestoladkomst"));
const ukjentAdkomst = scoreTilbud(rullestol, SPISEVENN, SPISEVENN.tilbud[0]!);
check("ikke oppgitt filtrerer ikke, men sies",
  ukjentAdkomst.score !== null
  && ukjentAdkomst.begrunnelseskoder.includes("rullestol_ikke_oppgitt"),
  JSON.stringify(ukjentAdkomst));
check("uten oppgitt behov sies ingenting om rullestol",
  scoreTilbud(profil({ alder: 70 }), TUR, TUR.tilbud[0]!)
    .begrunnelseskoder.every((k) => !k.startsWith("rullestol") && k !== "mangler_rullestoladkomst"));
check("et oppgitt nei til rullestolbehov filtrerer ikke",
  scoreTilbud(profil({ alder: 70, trengerRullestoladkomst: false }), TUR, TUR.tilbud[0]!)
    .score !== null);

// Teleslynge er et signal og aldri et filter: filtrering her ville skjult nesten
// hele katalogen.
const teleslynge = profil({ alder: 70, trengerTeleslynge: true });
check("teleslynge true gir poeng",
  scoreTilbud(teleslynge, KINO, KINO.tilbud[0]!).begrunnelseskoder.includes("teleslynge"));
const utenSlynge = scoreTilbud(teleslynge, TUR, TUR.tilbud[0]!);
check("teleslynge false utelukker ikke",
  utenSlynge.score !== null && utenSlynge.begrunnelseskoder.includes("teleslynge_mangler"),
  JSON.stringify(utenSlynge));
check("teleslynge ikke oppgitt utelukker ikke",
  scoreTilbud(teleslynge, SPISEVENN, SPISEVENN.tilbud[0]!)
    .begrunnelseskoder.includes("teleslynge_ikke_oppgitt"));

// --- 4. rangerTilbud --------------------------------------------------------

const rangert = rangerTilbud(byggSeniorprofil({
  kommunenummer: RINGERIKE,
  foedselsdato: "1956-03-04",
  referansedato: "2026-08-01",
  interesser: ["friluft"]
}, grupper), katalog);

check("alle radene gjøres rede for",
  rangert.forslag.length + rangert.utelukkede.length === rangert.antallVurdert,
  `${rangert.forslag.length} + ${rangert.utelukkede.length} av ${rangert.antallVurdert}`);
check("turgruppa ligger øverst for den som valgte friluft",
  rangert.forslag[0]?.tilbudId === "dnt-ringerike-seniorgruppa",
  rangert.forslag.map((f) => `${f.tilbudId}=${f.score}`).join(" "));
check("tilbyderens navn slås opp",
  rangert.forslag[0]?.tilbyder === "DNT Ringerike", String(rangert.forslag[0]?.tilbyder));
check("kommunens eget statusord bæres videre urørt",
  rangert.forslag[0]?.status === "krever-verifisering", String(rangert.forslag[0]?.status));
check("skåren faller nedover listen",
  rangert.forslag.every((f, i) => i === 0 || f.score <= rangert.forslag[i - 1]!.score),
  rangert.forslag.map((f) => f.score).join(","));

// Et tilbud uten et eneste treff står fortsatt i listen. «Hva finnes for meg» er
// ikke det samme spørsmålet som «hva passer best».
check("null poeng er ikke det samme som utelukket",
  rangert.forslag.some((f) => f.score === 0),
  rangert.forslag.map((f) => `${f.tilbudId}=${f.score}`).join(" "));

const utenfor = rangerTilbud(profil({ kommunenummer: "4601", alder: 70 }), katalog);
check("en katalog for en annen kommune gir ingen forslag",
  utenfor.forslag.length === 0 && utenfor.utelukkede.length === utenfor.antallVurdert);
check("og hver rad sier hvorfor",
  utenfor.utelukkede.every((u) => u.begrunnelseskoder.join(",") === "utenfor_kommunen"));

const medRullestol = rangerTilbud(
  byggSeniorprofil({
    kommunenummer: RINGERIKE, foedselsdato: "1956-03-04", referansedato: "2026-08-01",
    trengerRullestoladkomst: true
  }, grupper), katalog);
check("den utelukkede blir stående med koden sin",
  medRullestol.utelukkede.length === 1
  && medRullestol.utelukkede[0]!.tilbudId === "dnt-ringerike-seniorgruppa"
  && medRullestol.utelukkede[0]!.begrunnelseskoder.includes("mangler_rullestoladkomst"),
  JSON.stringify(medRullestol.utelukkede));

// Determinisme: kontraktdumpen normaliserer id-er og tidsstempler, men ikke
// rekkefølgen på en liste. To kjøringer av samme data må gi samme bytes.
check("to kjøringer gir samme svar",
  JSON.stringify(rangerTilbud(profil({ alder: 70 }), katalog))
  === JSON.stringify(rangerTilbud(profil({ alder: 70 }), katalog)));

// Lik skår sorteres på id, ikke på rekkefølgen i filen.
const lik = rangerTilbud(profil({ alder: 70, interesser: [], kategorier: [] }), {
  ...katalog,
  aktiviteter: [...katalog.aktiviteter].reverse()
});
const likOmvendt = rangerTilbud(profil({ alder: 70, interesser: [], kategorier: [] }), katalog);
check("rekkefølgen i katalogen påvirker ikke rekkefølgen ut",
  JSON.stringify(lik.forslag.map((f) => f.tilbudId))
  === JSON.stringify(likOmvendt.forslag.map((f) => f.tilbudId)),
  lik.forslag.map((f) => f.tilbudId).join(","));

// --- 5. Skåren er summen av delene -----------------------------------------

/*
 * Den bærende påstanden. Hvert tall i modulen står i én tabell, og skåren er
 * summen av vektene til kodene som slo til - så et poengtall skrevet for hånd et
 * annet sted ville brutt dette, uansett hvilken gren det stod i.
 */
const profiler: Seniorprofil[] = [
  profil({ alder: 70 }),
  profil({ alder: 70, interesser: ["friluft"], kategorier: ["friluftsliv-og-trening"] }),
  profil({ alder: 55, trengerRullestoladkomst: true, trengerTeleslynge: true }),
  profil(),
  profil({ kommunenummer: "4601", alder: 70 })
];
let rader = 0;
const sett = new Set<Begrunnelseskode>();
for (const p of profiler) {
  const svar = rangerTilbud(p, katalog);
  for (const rad of svar.forslag) {
    rader += 1;
    for (const kode of rad.begrunnelseskoder) sett.add(kode);
    const sum = rad.begrunnelseskoder.reduce((n, kode) => n + vektFor(kode), 0);
    check(`skåren er summen av delene for ${rad.tilbudId}`, rad.score === sum,
      `${rad.score} mot ${sum} (${rad.begrunnelseskoder.join(",")})`);
    check(`et forslag bærer ingen hard kode (${rad.tilbudId})`,
      rad.begrunnelseskoder.every((kode) => !erHardtKrav(kode)));
  }
  for (const rad of svar.utelukkede) {
    rader += 1;
    for (const kode of rad.begrunnelseskoder) sett.add(kode);
    check(`en utelukket rad bærer en hard kode (${rad.tilbudId})`,
      rad.begrunnelseskoder.some((kode) => erHardtKrav(kode)),
      rad.begrunnelseskoder.join(","));
  }
}
check("kjørte over alle radene i alle profilene", rader === profiler.length * 3, String(rader));

/*
 * En kode ingen gren kan produsere er død kode, og en union er dokumentasjon
 * framfor en sjekk helt til noen teller den. `teleslynge_mangler` nås ikke av
 * profilene over; den er dekket i seksjon 3 og listes her framfor å bli hentet
 * inn i løkken bare for tellingens skyld.
 */
const dekketAnnetsteds: Begrunnelseskode[] = ["teleslynge", "teleslynge_mangler",
  "teleslynge_ikke_oppgitt", "gjelder_alle"];
for (const kode of dekketAnnetsteds) sett.add(kode);
const udekket = BEGRUNNELSESKODER.filter((kode) => !sett.has(kode));
check("hver begrunnelseskode nås av en gren", udekket.length === 0, udekket.join(","));

// --- report ----------------------------------------------------------------
if (feil.length > 0) {
  console.error(`test-seniorsirkel: ${feil.length} av ${bestatt + feil.length} sjekker feilet.`);
  for (const linje of feil) console.error(`  - ${linje}`);
  process.exit(1);
}
console.log(`test-seniorsirkel ok. ${bestatt} sjekker, uten stack og uten modell.`);
