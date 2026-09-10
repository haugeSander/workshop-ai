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
import { nesteGang, parseAktivitetskatalog } from "../apps/shared/senioraktivitet.ts";
import type { Aktivitetskatalog, Seniortilbud, Tidspunkt, Tilbud }
  from "../apps/shared/senioraktivitet.ts";
import {
  BEGRUNNELSESKODER,
  byggProfilFraKilder,
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

// --- 1b. De to veiene inn ---------------------------------------------------

/*
 * Portalen kaller ruten med spørreparametere; prosessmotoren kaller den med en økt
 * bak seg. «Må oppføre seg likt begge veier» er en påstand, og den eneste måten å
 * holde den på er at det er én funksjon og ikke to - så det er dette som pinnes.
 *
 * Feltnavnene er kontrakten, ikke steg-id-ene: økten kan svare med et steg som
 * heter `interesser`, eller med et felt som heter det inne i et steg som heter noe
 * annet. Begge formene finnes i motoren i dag (replaceParametere i prosess.ts).
 */
const REGISTER = {
  kommunenummer: RINGERIKE,
  foedselsdato: "1956-03-04",
  referansedato: "2026-08-01"
};
const fraSpoerring = byggProfilFraKilder({
  ...REGISTER,
  spoerring: { grupper: "friluft,kultur", rullestol: "true", teleslynge: "false" }
}, grupper);
for (const [navn, oektsvar] of [
  ["steg som heter feltet", {
    interesser: "friluft,kultur", rullestol: "Ja", teleslynge: "Nei"
  }],
  ["felter inne i et steg", {
    "hva-liker-du": { interesser: "friluft,kultur" },
    tilgjengelighet: { rullestol: "Ja", teleslynge: "Nei" }
  }]
] as const) {
  check(`økten gir samme profil som spørringen (${navn})`,
    JSON.stringify(byggProfilFraKilder({ ...REGISTER, oektsvar }, grupper))
    === JSON.stringify(fraSpoerring),
    JSON.stringify(byggProfilFraKilder({ ...REGISTER, oektsvar }, grupper)));
}

// Spørringen vinner der begge svarer: motoren setter selv inn {svar.<steg>} i
// api-strengen, så en verdi i spørringen er noe kalleren har sagt uttrykkelig.
check("spørringen vinner over økten",
  byggProfilFraKilder({
    ...REGISTER,
    spoerring: { grupper: "kultur" },
    oektsvar: { interesser: "friluft" }
  }, grupper).interesser.join(",") === "kultur");

/*
 * «Vet ikke» er den tredje tilstanden i et ja-nei-felt, og den må komme ut som
 * ikke oppgitt. Lest som nei hadde den skjult ingenting; lest som ja hadde den
 * filtrert bort tilbud innbyggeren aldri ba om å slippe.
 */
for (const [navn, verdi] of [["Vet ikke", "Vet ikke"], ["tom streng", ""],
  ["utelatt", null]] as const) {
  const p = byggProfilFraKilder({
    ...REGISTER, spoerring: { rullestol: verdi }
  }, grupper);
  check(`«${navn}» er ikke oppgitt, verken ja eller nei`,
    !("trengerRullestoladkomst" in p), JSON.stringify(p));
}
check("nei er oppgitt, og ikke det samme som utelatt",
  byggProfilFraKilder({ ...REGISTER, spoerring: { rullestol: "Nei" } }, grupper)
    .trengerRullestoladkomst === false);

// Et DATA_FETCH-steg som peker på et ubesvart spørsmål lar plassholderen stå.
// Uten vakten leses den som et gruppenavn, og feilmeldingen skylder på innbyggeren.
kaster("en uerstattet {svar.…} navngis som det den er",
  () => byggProfilFraKilder({
    ...REGISTER, spoerring: { grupper: "{svar.interesser}" }
  }, grupper),
  "ikke besvart");

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

// --- 6. nesteGang -----------------------------------------------------------

/*
 * Katalogen har ingen datoer, bare gjentakelser. Både påminnelsen i varslingen og
 * påmeldingssvaret må kunne si *når*, og det regnes ut her.
 *
 * Fixturen rekker to av formene: turgruppa er tirsdag i en sesong, og spisevenn har
 * ingen tidspunkter i det hele tatt. Resten er literaler, av samme grunn som over -
 * hele katalogen har ingen sesong som går over nyttår og ingen med to tidspunkter,
 * så de grenene er døde så langt noe annet vet.
 *
 * Ingen av påstandene under leser klokken: `fraDato` er en parameter. Det er med
 * vilje - en test som spurte «hva er neste tirsdag fra i dag» ville byttet svar hver
 * uke, og en implementasjon som kalte `Date.now()` ville bestått den.
 */
function medTidspunkter(tidspunkter: Tidspunkt[]): Tilbud {
  return { ...TUR.tilbud[0]!, tidspunkter };
}
const TURTILBUD = TUR.tilbud[0]!;   // tirsdag 09:30, sesong april-oktober

// 2026-05-04 er en mandag, 2026-05-05 tirsdagen etter.
check("neste tirsdag fra mandagen før",
  nesteGang(TURTILBUD, "2026-05-04")?.dato === "2026-05-05",
  JSON.stringify(nesteGang(TURTILBUD, "2026-05-04")));
// Fra og med, ikke etter: en jobb som spør «hva går i dag» skal få dagens tilbud.
check("selve dagen teller med",
  nesteGang(TURTILBUD, "2026-05-05")?.dato === "2026-05-05");
check("dagen etter hopper en uke",
  nesteGang(TURTILBUD, "2026-05-06")?.dato === "2026-05-12");
check("klokkeslettet blir med",
  nesteGang(TURTILBUD, "2026-05-04")?.fraKlokkeslett === "09:30");
check("en tur uten sluttid får ingen tilKlokkeslett",
  nesteGang(TURTILBUD, "2026-05-04")?.tilKlokkeslett === undefined);

/*
 * Sesongen flytter søket, den stopper det ikke. I november er svaret første tirsdag
 * i april, ikke `null` - det er nettopp svaret «du er påmeldt, neste gang er i
 * april» trenger, og det sparer varslingsjobben for et sesongtilfelle: en dato som
 * ligger måneder fram er bare ikke i morgen.
 */
check("utenfor sesongen flyttes svaret til sesongstart",
  nesteGang(TURTILBUD, "2026-11-10")?.dato === "2027-04-06",
  JSON.stringify(nesteGang(TURTILBUD, "2026-11-10")));
check("siste dag i sesongen er med",
  nesteGang(TURTILBUD, "2026-10-27")?.dato === "2026-10-27");

// En sesong over nyttår finnes ikke i katalogen, men skjemaet tillater den
// uttrykkelig - lesTidspunkt krever ikke at fra er før til.
const vintertilbud = medTidspunkter([
  { ukedager: ["onsdag"], fraKlokkeslett: "18:00", sesong: { fraMaaned: 11, tilMaaned: 2 } }
]);
check("en sesong over nyttår er i sesong i desember",
  nesteGang(vintertilbud, "2026-12-01")?.dato === "2026-12-02",
  JSON.stringify(nesteGang(vintertilbud, "2026-12-01")));
check("og i januar",
  nesteGang(vintertilbud, "2027-01-04")?.dato === "2027-01-06");
check("men ikke i september",
  nesteGang(vintertilbud, "2026-09-01")?.dato === "2026-11-04",
  JSON.stringify(nesteGang(vintertilbud, "2026-09-01")));

// Tom ukedagsliste betyr hver dag, ikke ingen: aktivitetssenteret er åpent 08:30-15:00
// uten å nevne dager, og lest som «ingen dager» hadde det aldri hatt en neste gang.
check("uten ukedager er neste gang samme dag",
  nesteGang(medTidspunkter([{ ukedager: [], fraKlokkeslett: "08:30", tilKlokkeslett: "15:00" }]),
    "2026-05-06")?.dato === "2026-05-06");
check("og sluttiden blir med når den står der",
  nesteGang(medTidspunkter([{ ukedager: [], fraKlokkeslett: "08:30", tilKlokkeslett: "15:00" }]),
    "2026-05-06")?.tilKlokkeslett === "15:00");

// Ingen tidspunkter er «ingen fast gjentakelse», ikke «ikke nå». Sju av ti tilbud i
// katalogen er slike i dag - et kurs, en veiledning, en frivillig som kommer hjem.
check("et tilbud uten tidspunkter har ingen neste gang",
  nesteGang(SPISEVENN.tilbud[0]!, "2026-05-04") === null);

// Flere tidspunkter: det tidligste vinner, og rekkefølgen i filen avgjør ikke.
const toDager: Tidspunkt[] = [
  { ukedager: ["fredag"], fraKlokkeslett: "10:00" },
  { ukedager: ["onsdag"], fraKlokkeslett: "18:00" }
];
for (const [navn, rekkefoelge] of [["fredag først", toDager],
  ["onsdag først", [...toDager].reverse()]] as const) {
  const svar = nesteGang(medTidspunkter([...rekkefoelge]), "2026-05-04");
  check(`det tidligste tidspunktet vinner (${navn})`,
    svar?.dato === "2026-05-06" && svar?.fraKlokkeslett === "18:00", JSON.stringify(svar));
}
// Samme dag to ganger avgjøres på klokkeslettet.
const sammeDag: Tidspunkt[] = [
  { ukedager: ["onsdag"], fraKlokkeslett: "18:00" },
  { ukedager: ["onsdag"], fraKlokkeslett: "09:00" }
];
for (const rekkefoelge of [sammeDag, [...sammeDag].reverse()]) {
  check("samme dag avgjøres på klokkeslettet",
    nesteGang(medTidspunkter([...rekkefoelge]), "2026-05-04")?.fraKlokkeslett === "09:00");
}

/*
 * Månedsskifte, skuddår og årsskifte. Datoregningen går gjennom Date.UTC og
 * toISOString og aldri gjennom en lokal getter, men det er usynlig i UTC - så disse
 * er grensene som faller først hvis noen bytter til getDate/setDate. CI kjører
 * rulene en gang i norsk tid av samme grunn.
 */
const fredager = medTidspunkter([{ ukedager: ["fredag"], fraKlokkeslett: "10:00" }]);
check("over et månedsskifte", nesteGang(fredager, "2026-04-28")?.dato === "2026-05-01");
check("over et årsskifte", nesteGang(fredager, "2026-12-28")?.dato === "2027-01-01");
const skudd = medTidspunkter([{ ukedager: ["tirsdag"], fraKlokkeslett: "10:00" }]);
check("29. februar i et skuddår", nesteGang(skudd, "2028-02-27")?.dato === "2028-02-29",
  JSON.stringify(nesteGang(skudd, "2028-02-27")));

// --- report ----------------------------------------------------------------
if (feil.length > 0) {
  console.error(`test-seniorsirkel: ${feil.length} av ${bestatt + feil.length} sjekker feilet.`);
  for (const linje of feil) console.error(`  - ${linje}`);
  process.exit(1);
}
console.log(`test-seniorsirkel ok. ${bestatt} sjekker, uten stack og uten modell.`);
