import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { errorBody, headersFor, HttpError, statusFor } from "./errors.ts";
import { readRequestBody, svarhjelpere } from "../../shared/http.ts";

import {
  aktorFor,
  classifyKaller,
  requireTilgang,
  manglerHandleevne,
  SCOPE_LES,
  SCOPE_REVISJON,
  SCOPE_VARSLING,
  type Caller,
  type Tilgang
} from "./autentisering.ts";
// Who may act, and on whose behalf. One module, shared with digdir-mock, so the
// login screen and the process engine cannot disagree about the two thresholds.
import {
  vurderHandleevne,
  finnRepresentanter,
  forklarHandleevne,
  representantPider
} from "../../shared/handleevne.ts";
import { norskKalenderdato } from "../../shared/alder.ts";
import { aiBaseUrl, openapiFile } from "./config.ts";
import { tryUpstream } from "./upstream.ts";
import {
  byggBekreftelsestekst,
  finnArrangementer,
  hentVarselkanal,
  kjoerPaaminnelse,
  kjoerVarsling,
  lesUtsendinger,
  PAAMELDINGSHJEMMEL,
  sendEnkeltvarsel,
  SENIORSIRKEL_KONTAKT_HJEMMEL,
  utsendingsnoekkel,
  VARSELHJEMMEL
} from "./varsling.ts";
import {
  finnGjeldendeSeniorsirkelSamtykke,
  opprettSeniorsirkelSamtykke,
  svarSeniorsirkelSamtykke,
  trekkSeniorsirkelSamtykke
} from "./seniorsirkelsamtykke.ts";
import { byggBrevinnhold, lesBrevrad, renderBrevPdf, sendBrev } from "./brev.ts";
import { erBrevtype } from "../../shared/brev.ts";
import type { Brevtype } from "../../shared/brev.ts";
import { cors } from "../../shared/http.ts";
import { routeOverview } from "../../shared/openapi.ts";
import {
  fjernPortalregistrering,
  finnPortaltilbud,
  byggPortalvisning,
  hentAktivitetskatalog,
  hentInteressegrupper,
  hentPortalpreferanse,
  hentPortalregistreringer,
  lagrePortalpreferanse,
  lagrePortalregistreringer
} from "./innbyggerportal.ts";
import {
  buildProsessoektRespons,
  createSoknad,
  frysResultatKilder,
  erStegFullfort,
  invalidateStegOgSenere,
  lagreStegSvar,
  resultaterNaa,
  runStegHandling
} from "./prosess.ts";
import { findRessurs, ressurskatalog, runRessurs } from "./ressurser.ts";
import { addRevisjon } from "./revisjon.ts";
import { compilePathPattern, matchPath, type PathParams } from "./routing.ts";
import { readForsendelsesstatus } from "./svarut.ts";
import type { ProsessDefinisjon, Prosessoekt, State } from "./types.ts";
import {
  SEED_DATASETS,
  isMalProsess,
  findPerson,
  findProsess,
  findProsessIKatalog,
  findProsessoekt,
  getProsesserForVisning,
  mergeFrosneResultatKilder,
  updateProsesskatalog,
  lagreProsessoekt,
  readState,
  normalizeProsess,
  normalizeProsessoekt,
  newId
} from "./state.ts";

// Default policy: GET,POST,PUT,OPTIONS and Content-Type,Authorization, on both
// JSON and text responses. Same bytes this service has always sent.
const { jsonResponse, textResponse } = svarhjelpere();
const aktiveSteghandlinger = new Set<string>();

// Hand-written, not generated from the spec: it lists the routes a newcomer
// needs first, not all of them. routeOverview() below serves the complete list.

function docsHtml() {
  return `
  <!doctype html>
  <html lang="nb">
    <head><meta charset="utf-8"><title>Sandbox Backend API</title></head>
    <body style="font-family: Arial, sans-serif; padding: 24px;">
      <h1>Sandbox Backend API</h1>
      <p><a href="/openapi.yaml">Spesifikasjonen</a> · <a href="/openapi-ruter.json">Samme, lest, som JSON</a> · <a href="http://localhost:3001/utforsker">Prøv rutene i API-utforskeren</a></p>
      <ul>
        <li><code>GET /helse</code></li>
        <li><code>GET /api/personer</code></li>
        <li><code>GET /api/prosesser</code></li>
        <li><code>POST /api/prosessoekter</code></li>
        <li><code>GET /api/prosessoekter/{oektsId}</code></li>
        <li><code>POST /api/prosessoekter/{oektsId}/svar</code></li>
        <li><code>POST /api/prosessoekter/{oektsId}/handling</code></li>
        <li><code>POST /api/prosessoekter/{oektsId}/neste</code></li>
        <li><code>POST /api/prosessoekter/{oektsId}/forrige</code></li>
      </ul>
    </body>
  </html>`;
}



type Kontekst = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  parametere: PathParams;
  tilstand: State;
  /** Who is calling, from the token. See autentisering.ts. */
  kaller: Caller;
};

type Rute = {
  metode: string;
  sti: string;
  /**
   * Which authorisation this route requires. Omitting it means the closed value,
   * "egne-data" - so a route added during the hackathon is protected unless someone
   * opens it on purpose. Failing closed is the only default that survives a rush.
   */
  tilgang?: Tilgang;
  /** Scope a machine caller must hold. Defaults to SCOPE_LES. */
  scope?: string;
  /**
   * Whose data this route touches, for the pid binding. Returning null means the
   * route has no single subject - and then the handler must narrow the answer to
   * the caller itself. See the Tilgang docs in autentisering.ts.
   *
   * Runs after readState(), so it can look the subject up.
   */
  finnPersonId?: (kontekst: Omit<Kontekst, "kaller">) => string | null | Promise<string | null>;
  handter: (kontekst: Kontekst) => Promise<void> | void;
};

// --- who a route is about -------------------------------------------------

// A prosessoekt belongs to a person. Binding the token to the session's owner is
// the second half of the pid binding - without it the process path stays open even
// though the direct HTTP path is closed, because a SJEKK step runs with
// session.personId regardless of who asked.
function eierAvOekt({ parametere, tilstand }: { parametere: PathParams; tilstand: State }) {
  return findProsessoekt(tilstand, parametere.oektsId)?.personId ?? null;
}

function eierAvSoknad({ parametere, tilstand }: { parametere: PathParams; tilstand: State }) {
  return tilstand.soknader.find((s: any) => s.soknadId === parametere.soknadId)?.personId ?? null;
}

// A POST that creates something names its own subject in the body. Read once here
// rather than in each handler, so the check happens before the write.
async function personIdFromBody({ request }: { request: IncomingMessage }) {
  return (await readBodyOnce(request))?.personId ?? null;
}

// readRequestBody consumes the stream, so a route whose subject comes from the body
// would otherwise find it empty by the time the handler runs. Parse once, cache on
// the request, and let both the check and the handler read the same object.
const bodyCache = new WeakMap<IncomingMessage, any>();

async function readBodyOnce(request: IncomingMessage): Promise<any> {
  if (!bodyCache.has(request)) {
    // The one place readRequestBody is still called. Everything else goes through
    // this cache, so the stream is consumed exactly once per request.
    bodyCache.set(request, await readRequestBody(request));
  }
  return bodyCache.get(request);
}

function getSporingsId(url: URL) {
  return url.searchParams.get("sporingsId") || newId("flyt");
}

function portalperson(
  tilstand: State,
  kaller: Caller,
  oppgittPersonId?: unknown
) {
  const person = kaller.type === "innbygger"
    ? tilstand.personer.find((kandidat: any) => kandidat.syntetiskFodselsnummer === kaller.pid)
    : tilstand.personer.find((kandidat: any) => kandidat.personId === oppgittPersonId);
  if (!person) {
    throw new HttpError(
      kaller.type === "system" ? "Maskinkall mangler en gyldig personId." : "Fant ikke innlogget person.",
      kaller.type === "system" ? 400 : 404
    );
  }
  return person;
}

/**
 * Portalvisningen for én innbygger, skåret av `rangerTilbud`.
 *
 * Kommunen og fødselsdatoen leses av registeret og aldri av spørringen, av samme
 * grunn som i /api/seniorsirkel/forslag: en kaller som kunne oppgi kommunen sin
 * selv, hadde gjort det harde kravet i skåringen til en innstilling.
 */
async function portalvisning(
  person: { personId: string; foedselsdato?: string },
  valgtTilbudId?: string | null
) {
  if (!person.foedselsdato) {
    throw new HttpError("Mockpersonen mangler fødselsdato.", 500);
  }
  const [preferanse, registreringer] = await Promise.all([
    hentPortalpreferanse(person.personId),
    hentPortalregistreringer(person.personId)
  ]);
  return byggPortalvisning({
    personId: person.personId,
    foedselsdato: person.foedselsdato,
    kommunenummer: (person as { bostedsadresse?: { kommunenummer?: string | null } })
      .bostedsadresse?.kommunenummer,
    referansedato: norskKalenderdato(),
    preferanse,
    registreringer,
    ...(valgtTilbudId === undefined ? {} : { valgtTilbudId })
  });
}

/**
 * Telefonnummeret til kommunen selv, fra katalogens tilbyderliste.
 *
 * Lest av data, ikke en kode-konstant: det er det samme nummeret footeren i
 * brev-kjell.pdf viser, «32 11 74 00», og en kommune som bytter katalog skal
 * ikke måtte finne en hardkodet streng i tillegg.
 */
function finnKommunetelefon(katalog: { tilbydere?: { tilbyderId: string; kontakt?: Record<string, unknown> }[] }): string {
  const kommune = katalog.tilbydere?.find((rad) => rad.tilbyderId === "ringerike-kommune");
  const telefon = kommune?.kontakt?.telefon;
  return typeof telefon === "string" ? telefon : "";
}

/** Dagens dato i Europe/Oslo, som «10.09.2026». Ombygging av norskKalenderdato()s ISO-streng, ikke en ny klokke. */
function brevdato(): string {
  return norskKalenderdato().split("-").reverse().join(".");
}

/**
 * Kanalen for én person, og om hun hører til brev-sporet.
 *
 * Ett sted, ikke to: `/kanal/:personId` og `/brev/utkast` stilte begge det
 * samme spørsmålet før denne fantes, og en endring i den ene predikatet uten
 * den andre er nettopp driften AGENTS.md advarer mot.
 */
/**
 * Raden for et varsel som allerede gikk ut, når sendEnkeltvarsel svarer
 * `null` fordi nøkkelen alt fantes.
 *
 * En stepper som lar en fasilitator gå tilbake til et steg må kunne vise det
 * steget som fullført uten å late som om et nytt varsel ble sendt - se
 * "view, not resend" i planen for varsel-SMS-veiviseren.
 */
async function finnEksisterendeUtsending(kandidat: {
  varseltype: string; personId: string; tilbudId?: string; dato?: string;
}) {
  const noekkel = utsendingsnoekkel(kandidat as any);
  const alle = await lesUtsendinger();
  return alle.find((rad) => rad.noekkel === noekkel) ?? null;
}

async function hentKanalinfo(person: { personId: string; syntetiskFodselsnummer: string; bostedsadresse?: any }) {
  const utfall = await hentVarselkanal(person.syntetiskFodselsnummer);
  if (!utfall.ok) throw utfall.error;
  const adresse = person.bostedsadresse;
  const harGyldigPostadresse = Boolean(adresse?.adressenavn && adresse?.postnummer && adresse?.poststed);
  const kanal = utfall.data?.kanal ?? "INGEN";
  return {
    kanal,
    grunn: utfall.data?.grunn,
    kanBrev: kanal === "INGEN" && harGyldigPostadresse
  };
}

// --- the økt contract, in one place ----------------------------------------

/*
 * Mutations of one økt run in arrival order, while different økter remain
 * independent. The tail promises contain no handler work themselves, so they
 * always resolve and one failed request cannot wedge the next one.
 */
const sessionTails = new Map<string, Promise<void>>();

async function runForSession<T>(oektsId: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionTails.get(oektsId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  sessionTails.set(oektsId, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (sessionTails.get(oektsId) === tail) {
      sessionTails.delete(oektsId);
    }
  }
}

/**
 * Every route on one prosessoekt goes through here: lookup, 404, 409,
 * oppdatert-stamp and save have one owner, so one drift surface.
 *
 * `lesing` is the one knob, because the two things it decides always moved
 * together. A write on an AVVIST or FULLFORT økt is refused - a replayed POST
 * /handling on a FULLFORT økt would otherwise run the SUBMIT handler again and
 * produce a duplicate søknad and a new Fiks task per call - and a read neither
 * refuses nor stamps `oppdatert`. demo-gui renders finished and rejected økter,
 * and a rejection you cannot look at afterwards would be worse than the replay
 * this closes.
 *
 * `fn` is the handler's single mutation. Returning nothing answers with the
 * plain økt response; returning a value answers `{ oekt, resultat }`, which is
 * the published shape of POST /handling. The checkpoint lets a long-running
 * action claim the current version and persist invalidation before it calls an
 * upstream service.
 */
async function withSession(
  { response, parametere, tilstand, kaller }: Pick<Kontekst, "response" | "parametere" | "tilstand" | "kaller">,
  {
    lesing = false,
    underSteghandling = false,
    afterSave
  }: {
    lesing?: boolean;
    underSteghandling?: boolean;
    afterSave?: (session: Prosessoekt, prosess: ProsessDefinisjon) => Promise<void> | void;
  },
  fn: (
    session: Prosessoekt,
    prosess: ProsessDefinisjon,
    checkpoint: () => Promise<void>,
    currentState: State
  ) => Promise<unknown> | unknown
) {
  if (!lesing && !underSteghandling && aktiveSteghandlinger.has(parametere.oektsId)) {
    throw new HttpError("En steghandling pågår allerede for prosessøkten.", 409);
  }
  const execute = async (currentState: State) => {
    const session = findProsessoekt(currentState, parametere.oektsId);
    if (!session) {
      throw new HttpError("Fant ikke prosessøkt.", 404);
    }
    if (!lesing && (session.status === "AVVIST" || session.status === "FULLFORT")) {
      throw new HttpError("Prosessøkten er avsluttet og kan ikke fortsette.", 400);
    }
    // The prosessbygger can delete a published process while an økt is mid-flow,
    // and then the økt points at nothing. 409 says what actually happened.
    const prosess = findProsess(currentState, session.prosessId);
    if (!prosess) {
      throw new HttpError(`Prosessøkten peker på prosessen ${session.prosessId}, som ikke finnes lenger.`, 409);
    }
    frysResultatKilder(currentState, session, prosess);
    let forventetOppdatert = session.oppdatert;
    const checkpoint = async () => {
      const forrigeTid = Date.parse(forventetOppdatert);
      session.oppdatert = new Date(
        Math.max(Date.now(), Number.isNaN(forrigeTid) ? 0 : forrigeTid + 1)
      ).toISOString();
      await lagreProsessoekt(session, { oppdatert: forventetOppdatert });
      forventetOppdatert = session.oppdatert;
    };
    const resultat = await fn(session, prosess, checkpoint, currentState);
    if (!lesing) {
      await checkpoint();
      await afterSave?.(session, prosess);
    }
    // Porten gjelder også når økten svarer med det den hentet tidligere. Et trukket
    // eller utløpt samtykke tar resultatet ut av svaret, her og ikke per rute.
    const { resultater, gjenlest } = resultaterNaa(currentState, session, prosess);
    await loggGjenleste(currentState, session, gjenlest, kaller);
    const oektSvar = buildProsessoektRespons(session, prosess, resultater);
    jsonResponse(response, 200, resultat === undefined ? oektSvar : { oekt: oektSvar, resultat });
  };

  if (lesing) {
    return execute(tilstand);
  }
  return runForSession(parametere.oektsId, async () => {
    // Every request loaded state before authorisation. Read it again only after
    // this økt's previous mutation has saved, or the status check is still stale.
    if (underSteghandling) aktiveSteghandlinger.add(parametere.oektsId);
    try {
      return await execute(await readState());
    } finally {
      if (underSteghandling) aktiveSteghandlinger.delete(parametere.oektsId);
    }
  });
}

/*
 * Alle fem øktrutene svarer med det stegene hentet, og det er en datatilgang.
 * GET var alene om å skrive raden, så en agentsløyfe som bare kaller /neste var
 * usynlig i sporet. Én rad per kilde per økt, ikke per henting: sløyfa poller, og
 * addRevisjon skriver hele revisjonsloggen om igjen inne i den delte skrivekøen.
 */
async function loggGjenleste(
  tilstand: State,
  session: Prosessoekt,
  gjenlest: string[],
  kaller: Caller
) {
  if (gjenlest.length === 0) return;
  const alleredeLogget = new Set(
    (tilstand.revisjonslogg || [])
      .filter((rad: any) => rad.sporingsId === session.sporingsId && rad.formaal === GJENLESING)
      .map((rad: any) => rad.ressurs)
  );
  for (const kilde of gjenlest) {
    if (alleredeLogget.has(kilde)) continue;
    await addRevisjon({
      sporingsId: session.sporingsId,
      handling: "DATA_LES",
      ressurs: kilde,
      formaal: GJENLESING,
      aktor: aktorFor(kaller, session.personId)
    });
  }
}

// --- system routes: answer without reading state --------------------------

// A health probe that needs credentials cannot tell you the service is unhealthy,
// and documentation is not data. All three are open.
const systemruter: Rute[] = [
  {
    metode: "GET",
    tilgang: "aapen",
    sti: "/helse",
    handter: ({ response }) => {
      jsonResponse(response, 200, { status: "ok", tjeneste: "sandbox-backend", tidspunkt: new Date().toISOString() });
    }
  },
  {
    metode: "GET",
    tilgang: "aapen",
    sti: "/docs",
    handter: ({ response }) => {
      textResponse(response, 200, docsHtml());
    }
  },
  {
    metode: "GET",
    tilgang: "aapen",
    sti: "/openapi.yaml",
    handter: async ({ response }) => {
      textResponse(response, 200, await readFile(openapiFile, "utf8"), "text/yaml; charset=utf-8");
    }
  },
  {
    metode: "GET",
    tilgang: "aapen",
    sti: "/openapi-ruter.json",
    // Den samme spesifikasjonen, lest. Se kommentaren i tools-api.
    handter: async ({ response }) => {
      jsonResponse(response, 200, await routeOverview(openapiFile));
    }
  }
];

// --- routes that need state -----------------------------------------------

const ruter: Rute[] = [
  {
    metode: "GET",
    tilgang: "aapen",
    sti: "/api/innbyggerportal/placeholder/aktiviteter",
    handter: async ({ response }) => {
      jsonResponse(response, 200, await hentAktivitetskatalog());
    }
  },
  {
    metode: "GET",
    sti: "/api/personer",
    // No single subject, so the handler narrows instead: an innbygger sees only
    // themselves. That is how demo-gui learns who it is logged in as, and it is
    // why a citizen token cannot be used to enumerate the population here.
    handter: ({ response, tilstand, kaller }) => {
      // visningsnavn saves every client from assembling the name itself.
      const alle = tilstand.personer.map((person: any) => ({
        ...person,
        visningsnavn: [person.navn.fornavn, person.navn.mellomnavn, person.navn.etternavn]
          .filter(Boolean).join(" ")
      }));
      const visible = kaller.type === "innbygger"
        ? alle.filter((person: any) => person.syntetiskFodselsnummer === kaller.pid)
        : alle;
      jsonResponse(response, 200, visible);
    }
  },
  {
    metode: "GET",
    sti: "/api/innbyggerportal/placeholder/meg",
    handter: ({ response, url, tilstand, kaller }) => {
      const person = portalperson(tilstand, kaller, url.searchParams.get("personId"));
      jsonResponse(response, 200, {
        ...person,
        visningsnavn: [person.navn.fornavn, person.navn.mellomnavn, person.navn.etternavn]
          .filter(Boolean).join(" "),
        mock: true,
        syntetisk: true
      });
    }
  },
  {
    metode: "GET",
    sti: "/api/innbyggerportal/placeholder/preferanser",
    handter: async ({ response, url, tilstand, kaller }) => {
      const person = portalperson(tilstand, kaller, url.searchParams.get("personId"));
      const preferanse = await hentPortalpreferanse(person.personId);
      jsonResponse(response, 200, {
        personId: person.personId,
        ferdigstilt: preferanse !== null,
        grupper: preferanse?.grupper ?? [],
        // Utelatt betyr ikke oppgitt, den tredje tilstanden. Se Portalpreferanse.
        ...(preferanse?.rullestol === undefined ? {} : { rullestol: preferanse.rullestol }),
        ...(preferanse?.teleslynge === undefined ? {} : { teleslynge: preferanse.teleslynge }),
        tilgjengeligeGrupper: await hentInteressegrupper(),
        mock: true,
        syntetisk: true
      });
    }
  },
  {
    metode: "PUT",
    sti: "/api/innbyggerportal/placeholder/preferanser",
    handter: async ({ request, response, url, tilstand, kaller }) => {
      const body = await readBodyOnce(request);
      const person = portalperson(tilstand, kaller, body.personId);
      let preferanse;
      try {
        preferanse = await lagrePortalpreferanse(person.personId, {
          grupper: body.grupper,
          rullestol: body.rullestol,
          teleslynge: body.teleslynge
        });
      } catch (feil) {
        throw new HttpError(feil instanceof Error ? feil.message : "Ugyldige kategorier.", 400);
      }
      await addRevisjon({
        sporingsId: getSporingsId(url),
        handling: "PORTALPREFERANSER_OPPDATERT",
        ressurs: "innbyggerportal-preferanser",
        formaal: "Tilpasse anbefalte aktiviteter",
        gjaldt: person.personId,
        antall: preferanse.grupper.length,
        aktor: aktorFor(kaller, person.personId)
      });
      jsonResponse(response, 200, {
        ...preferanse,
        ferdigstilt: true,
        tilgjengeligeGrupper: await hentInteressegrupper(),
        mock: true,
        syntetisk: true
      });
    }
  },
  {
    metode: "GET",
    sti: "/api/innbyggerportal/placeholder/tilbud",
    handter: async ({ response, url, tilstand, kaller }) => {
      const person = portalperson(tilstand, kaller, url.searchParams.get("personId"));
      const visning = await portalvisning(person, url.searchParams.get("tilbudId"));
      await addRevisjon({
        sporingsId: getSporingsId(url),
        handling: "PORTALTILBUD_VIST",
        ressurs: "innbyggerportal-tilbud",
        formaal: "Vise relevante kommunale tilbud",
        gjaldt: person.personId,
        aktor: aktorFor(kaller, person.personId)
      });
      jsonResponse(response, 200, { ...visning, mock: true, syntetisk: true });
    }
  },
  {
    /*
     * Setningen som sier hvorfor hvert tilbud står der det står.
     *
     * Egen rute og ikke en del av /tilbud, fordi de to har hver sin hastighet:
     * kortene er skåringens svar og skal stå med én gang, mens setningen er et
     * modellkall. Portalen tegner listen først og fyller inn setningene når de
     * kommer - da ser innbyggeren aldri en tom side mens en modell tenker, og
     * det er synlig hvilket lag som avgjorde og hvilket som formulerte.
     *
     * **Kodene bygges her, ikke av kalleren.** Ruten kjører skåringen på nytt og
     * sender modellen det den kom fram til. En klient som kunne oppgi
     * begrunnelseskodene selv, kunne fått modellen til å skrive hva som helst om
     * et tilbud - og det ville stått som kommunens tekst.
     *
     * Beste forsøk: `tryUpstream`, så en KI-gateway som er nede blir en advarsel
     * og ikke en 502. Gatewayen svarer med regelens setning i samme tilfelle, og
     * dette er laget som svarer når den ikke svarer i det hele tatt.
     */
    metode: "GET",
    sti: "/api/innbyggerportal/placeholder/begrunnelser",
    handter: async ({ response, url, tilstand, kaller }) => {
      const person = portalperson(tilstand, kaller, url.searchParams.get("personId"));
      const visning = await portalvisning(person);
      const rader = [...visning.anbefalte, ...visning.utelukkede];
      if (!visning.portalTilgjengelig || rader.length === 0) {
        jsonResponse(response, 200, { begrunnelser: [], mock: true, syntetisk: true });
        return;
      }
      const sporingsId = getSporingsId(url);
      const svar = await tryUpstream<any>(
        { service: "KI-tjenesten", action: "Å skrive begrunnelsene" },
        () => fetch(`${aiBaseUrl}/ai/begrunn-tilbud`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sporingsId,
            sprak: "nb",
            kontekst: {
              tilbud: rader.map((rad) => ({
                tilbudId: rad.tilbudId,
                navn: rad.tilbudsnavn ?? rad.navn,
                beskrivelse: rad.beskrivelse,
                begrunnelseskoder: rad.begrunnelseskoder
              }))
            }
          })
        })
      );
      jsonResponse(response, 200, svar.ok
        ? { ...svar.data, sporingsId, mock: true, syntetisk: true }
        : {
          begrunnelser: [],
          sporingsId,
          advarsel: svar.error.message,
          mock: true,
          syntetisk: true
        });
    }
  },
  {
    /*
     * Samtykket til personlig kontakt om seniortilbud, slik portalen ber om
     * det (se seniorsirkelsamtykke.ts for hvorfor formålet er et eget en, og
     * ikke en DATAKILDER-verdi). Ikke lenger en placeholder: ruten svarer med
     * det Fiks faktisk lagret.
     */
    metode: "GET",
    sti: "/api/innbyggerportal/placeholder/samtykke",
    handter: async ({ response, url, tilstand, kaller }) => {
      const person = portalperson(tilstand, kaller, url.searchParams.get("personId"));
      const samtykke = await finnGjeldendeSeniorsirkelSamtykke(person.personId);
      jsonResponse(response, 200, { samtykke, mock: true, syntetisk: true });
    }
  },
  {
    metode: "POST",
    sti: "/api/innbyggerportal/placeholder/samtykke",
    handter: async ({ request, response, url, tilstand, kaller }) => {
      const body = await readBodyOnce(request);
      const person = portalperson(tilstand, kaller, body.personId);
      const samtykke = await opprettSeniorsirkelSamtykke(person.personId, getSporingsId(url));
      jsonResponse(response, 201, { ...samtykke, mock: true, syntetisk: true });
    }
  },
  {
    metode: "PUT",
    sti: "/api/innbyggerportal/placeholder/samtykke/:samtykkeId/svar",
    handter: async ({ request, response, parametere, url, tilstand, kaller }) => {
      const body = await readBodyOnce(request);
      const person = portalperson(tilstand, kaller, body.personId);
      const status = body.status === "IKKE_SAMTYKKET" ? "IKKE_SAMTYKKET" : "SAMTYKKET";
      const samtykke = await svarSeniorsirkelSamtykke(
        parametere.samtykkeId, status, getSporingsId(url), aktorFor(kaller, person.personId));
      jsonResponse(response, 200, { ...samtykke, mock: true, syntetisk: true });
    }
  },
  {
    /** Trekker et samtykke som allerede er gitt. Egen rute og ikke .../svar med en tredje statusverdi: SAMTYKKEOVERGANGER lar bare SAMTYKKET -> TRUKKET, aldri VENTER_PAA_SVAR -> TRUKKET. */
    metode: "PUT",
    sti: "/api/innbyggerportal/placeholder/samtykke/:samtykkeId/trekk",
    handter: async ({ request, response, parametere, url, tilstand, kaller }) => {
      const body = await readBodyOnce(request);
      const person = portalperson(tilstand, kaller, body.personId);
      const samtykke = await trekkSeniorsirkelSamtykke(
        parametere.samtykkeId, getSporingsId(url), aktorFor(kaller, person.personId));
      jsonResponse(response, 200, { ...samtykke, mock: true, syntetisk: true });
    }
  },
  {
    metode: "GET",
    sti: "/api/innbyggerportal/placeholder/kontaktinfo",
    handter: ({ response, url, tilstand, kaller }) => {
      const person = portalperson(tilstand, kaller, url.searchParams.get("personId"));
      jsonResponse(response, 200, {
        personId: person.personId,
        epost: { adresse: "innbygger@example.test" },
        tlf: { nummer: "+4799999999" },
        mock: true,
        syntetisk: true
      });
    }
  },
  {
    metode: "GET",
    sti: "/api/innbyggerportal/placeholder/registreringer",
    handter: async ({ response, url, tilstand, kaller }) => {
      const person = portalperson(tilstand, kaller, url.searchParams.get("personId"));
      const registreringer = await hentPortalregistreringer(person.personId);
      jsonResponse(response, 200, { registreringer, mock: true, syntetisk: true });
    }
  },
  {
    metode: "POST",
    sti: "/api/innbyggerportal/placeholder/registreringer",
    handter: async ({ request, response, tilstand, kaller, url }) => {
      const body = await readBodyOnce(request);
      const person = portalperson(tilstand, kaller, body.personId);
      const aktuelle = await portalvisning(person);
      const tilbudIder: string[] = Array.isArray(body.tilbudIder)
        ? [...new Set<string>(body.tilbudIder.filter((verdi: unknown): verdi is string => typeof verdi === "string"))]
        : [];
      if (!aktuelle.portalTilgjengelig || tilbudIder.length === 0) {
        throw new HttpError("Velg minst ett tilgjengelig tilbud.", 400);
      }
      /*
       * Porten er den samme skåringen portalen viser, og de utelukkede er *ikke*
       * med. Et tilbud et hardt krav stengte står i visningen fordi innbyggeren
       * har krav på å vite at det finnes - det gjør det ikke til noe hun kan
       * melde seg på herfra. Skåringen avgjør begge deler, så en dør en rullestol
       * ikke kommer gjennom kan ikke bli en påmelding ved å kalle ruten direkte.
       */
      const aapne = new Map([...aktuelle.anbefalte, ...aktuelle.andre]
        .map((rad) => [rad.tilbudId, rad]));
      const valgte = await Promise.all(tilbudIder.map(async (tilbudId) => {
        const treff = aapne.has(tilbudId) ? await finnPortaltilbud(tilbudId) : null;
        if (!treff) {
          throw new HttpError(`Tilbudet ${tilbudId} er ikke tilgjengelig for innbyggeren.`, 400);
        }
        return treff;
      }));
      let opprettet;
      try {
        opprettet = await lagrePortalregistreringer(person.personId, valgte);
      } catch (feil) {
        throw new HttpError(feil instanceof Error ? feil.message : "Kunne ikke registrere påmeldingen.", 409);
      }
      const sporingsId = getSporingsId(url);
      await addRevisjon({
        sporingsId,
        handling: "PORTALREGISTRERING_OPPRETTET",
        ressurs: "innbyggerportal-registrering",
        formaal: "Følge opp tilbud innbyggeren har valgt",
        gjaldt: person.personId,
        antall: opprettet.length,
        aktor: aktorFor(kaller, person.personId)
      });
      /*
       * Bekreftelsen. Best effort, som Fiks-oppgaven og SvarUt-kvitteringen ved
       * en SUBMIT: påmeldingen er allerede lagret, og innbyggeren skal ikke måtte
       * melde seg på igjen fordi en SMS ikke gikk. Utfallet blir stående i
       * ledgeren, så «hun fikk ingen bekreftelse» er et spørsmål med et svar.
       *
       * Hjemmelen er en annen enn for det uanmodede varselet: hun har nettopp
       * bedt om dette. Derfor PAAMELDINGSHJEMMEL og ikke VARSELHJEMMEL.
       */
      const bekreftelser = [];
      for (const registrering of opprettet) {
        const arrangementer = await finnArrangementer(new Date().toISOString().slice(0, 10));
        const neste = arrangementer.find((rad) => rad.tilbudId === registrering.tilbudId)?.neste
          ?? null;
        const rad = await sendEnkeltvarsel({
          personId: person.personId,
          fnr: (person as any).syntetiskFodselsnummer,
          varseltype: "paamelding-bekreftet",
          tilbudId: registrering.tilbudId,
          ...(neste ? { dato: neste.dato } : {}),
          tekst: byggBekreftelsestekst(registrering.navn, neste)
        }, { sporingsId, hjemmel: PAAMELDINGSHJEMMEL });
        if (rad) bekreftelser.push({ tilbudId: registrering.tilbudId, kanal: rad.kanal, grunn: rad.grunn });
      }

      jsonResponse(response, 201, {
        registreringer: opprettet,
        // Kanalen er med i svaret, så portalen kan si «bekreftelse sendt på SMS»
        // eller «du er reservert, så vi kan ikke minne deg på» der og da - framfor
        // at innbyggeren oppdager det ved at ingenting kommer.
        bekreftelser,
        sporingsId,
        mock: true,
        syntetisk: true
      });
    }
  },
  {
    /*
     * Påminnelsen om ett arrangement, til alle som er påmeldt.
     *
     * Kommunens jobb, ikke innbyggerens: samme `bred` og samme scope som
     * batchvarslingen. `fraDato` lar en demo simulere at tiden nærmer seg uten å
     * stille klokken - og fordi ledgernøkkelen bærer datoen `nesteGang` kom fram
     * til, er neste ukes påminnelse en ny rad framfor en kvalt duplikat.
     */
    metode: "POST",
    sti: "/api/varsel/seniorsirkel/paaminnelse",
    tilgang: "bred",
    scope: SCOPE_VARSLING,
    finnPersonId: () => null,
    handter: async ({ request, response, tilstand, url }) => {
      const body = await readBodyOnce(request);
      const tilbudId = body?.tilbudId || url.searchParams.get("tilbudId");
      if (!tilbudId) {
        throw new HttpError("tilbudId er påkrevd.", 400);
      }
      try {
        jsonResponse(response, 200, {
          ...(await kjoerPaaminnelse(tilstand, {
            tilbudId: String(tilbudId),
            sporingsId: getSporingsId(url),
            ...(body?.fraDato ? { fraDato: String(body.fraDato) } : {})
          })),
          syntetisk: true
        });
      } catch (feil) {
        throw new HttpError(feil instanceof Error ? feil.message : "Påminnelsen feilet.", 400);
      }
    }
  },
  {
    /** Arrangementene som kan minnes om, med neste gang. Til nedtrekket. */
    metode: "GET",
    sti: "/api/varsel/seniorsirkel/arrangementer",
    tilgang: "bred",
    scope: SCOPE_VARSLING,
    finnPersonId: () => null,
    handter: async ({ response, url }) => {
      const fraDato = url.searchParams.get("fraDato")
        || new Date().toISOString().slice(0, 10);
      jsonResponse(response, 200, {
        fraDato,
        arrangementer: await finnArrangementer(fraDato),
        syntetisk: true
      });
    }
  },
  {
    metode: "DELETE",
    sti: "/api/innbyggerportal/placeholder/registreringer/:registreringId",
    handter: async ({ response, url, parametere, tilstand, kaller }) => {
      const person = portalperson(tilstand, kaller, url.searchParams.get("personId"));
      const fjernet = await fjernPortalregistrering(person.personId, parametere.registreringId);
      if (!fjernet) {
        throw new HttpError("Fant ikke påmeldingen.", 404);
      }
      const sporingsId = getSporingsId(url);
      await addRevisjon({
        sporingsId,
        handling: "PORTALREGISTRERING_FJERNET",
        ressurs: "innbyggerportal-registrering",
        formaal: "Avslutte en påmelding etter ønske fra innbyggeren",
        gjaldt: person.personId,
        aktor: aktorFor(kaller, person.personId)
      });
      jsonResponse(response, 200, {
        registrering: fjernet,
        sporingsId,
        mock: true,
        syntetisk: true
      });
    }
  },
  {
    metode: "GET",
    tilgang: "aapen",
    sti: "/api/regler/satser",
    handter: ({ response, tilstand }) => {
      jsonResponse(response, 200, tilstand.satser);
    }
  },
  {
    metode: "GET",
    // Open because process definitions are not person data. They are the
    // workshop's raw material, and the prosessbygger reads and writes them
    // without a token - a deliberate line, not an oversight. Do not "fix" it.
    tilgang: "aapen",
    sti: "/api/prosesser",
    handter: ({ response, url, tilstand }) => {
      const inkluderMaler = url.searchParams.get("inkluderMaler") === "true";
      jsonResponse(response, 200, getProsesserForVisning(tilstand, inkluderMaler));
    }
  },
  {
    metode: "POST",
    tilgang: "aapen",
    sti: "/api/prosesser",
    handter: async ({ request, response }) => {
      const body = await readBodyOnce(request);
      const nyProsess = normalizeProsess({
        id: body.id || newId("prosess"),
        navn: body.navn || "Ny prosess",
        beskrivelse: body.beskrivelse || "Prosess opprettet i prosessbyggeren.",
        versjon: body.versjon || "0.1.0",
        steg: Array.isArray(body.steg) ? body.steg : [],
        redigering: body.redigering || {},
        syntetisk: true
      });
      // The duplicate check belongs inside the queue, next to the append: run
      // against the request's own copy of the katalog and two saves at once both
      // pass it, and one of them is then written away.
      await updateProsesskatalog((katalog) => {
        if (findProsessIKatalog(katalog, nyProsess.id)) {
          throw new HttpError("Prosess med samme id finnes allerede.", 409);
        }
        (isMalProsess(nyProsess) ? katalog.maler : katalog.prosesser).push(nyProsess);
      });
      await addRevisjon({
        sporingsId: newId("flyt"),
        handling: "PROSESS_OPPRETTET",
        ressurs: "prosess",
        aktor: { type: "utvikler", id: "prosessbygger" }
      });
      jsonResponse(response, 201, nyProsess);
    }
  },
  {
    metode: "GET",
    tilgang: "aapen",
    sti: "/api/katalog/datasett",
    handter: ({ response }) => {
      // Built from state.ts's SEED_DATASETS, not from a literal here: the literal
      // listed four of eleven and hid the data three of the five cases run on.
      // The response key stays `fil` - it is published wire format; only the
      // constant's own property is English.
      jsonResponse(
        response,
        200,
        SEED_DATASETS.map(({ id, file }) => ({ id, fil: `data/${file}`, syntetisk: true }))
      );
    }
  },
  {
    metode: "GET",
    tilgang: "aapen",
    sti: "/api/katalog/informasjonsmodeller",
    handter: ({ response, tilstand }) => {
      jsonResponse(response, 200, tilstand.informasjonsmodeller);
    }
  },
  {
    // Lets whoever writes a DATA_FETCH or SJEKK step look up which URLs exist
    // instead of guessing.
    metode: "GET",
    tilgang: "aapen",
    sti: "/api/katalog/ressurser",
    handter: ({ response }) => {
      jsonResponse(response, 200, ressurskatalog());
    }
  },
  {
    metode: "GET",
    sti: "/api/personer/:personId/soknader",
    finnPersonId: ({ parametere }) => parametere.personId,
    handter: ({ response, parametere, tilstand }) => {
      jsonResponse(response, 200, tilstand.soknader.filter((soknad: any) => soknad.personId === parametere.personId));
    }
  },
  {
    metode: "GET",
    tilgang: "aapen",
    sti: "/api/prosesser/:prosessId",
    handter: ({ response, parametere, tilstand }) => {
      const prosess = findProsess(tilstand, parametere.prosessId);
      jsonResponse(response, prosess ? 200 : 404, prosess || { feil: "Fant ikke prosess." });
    }
  },
  {
    metode: "PUT",
    tilgang: "aapen",
    sti: "/api/prosesser/:prosessId",
    handter: async ({ request, response, parametere, tilstand }) => {
      const body = await readBodyOnce(request);
      const eksisterendeProsess = findProsess(tilstand, parametere.prosessId);
      if (eksisterendeProsess) {
        // Eldre økter har ikke kildemetadata. Frys dem mot definisjonen som fortsatt
        // gjelder før prosessbyggeren erstatter den, så samme steg-id ikke kan gi
        // resultatet en svakere klassifisering etterpå.
        const frosne: Prosessoekt[] = [];
        for (const oekt of tilstand.prosessoekter) {
          if (oekt.prosessId !== parametere.prosessId) continue;
          const kopi = normalizeProsessoekt(structuredClone(oekt));
          if (frysResultatKilder(tilstand, kopi, eksisterendeProsess)) {
            frosne.push(kopi);
          }
        }
        if (frosne.length > 0) {
          await mergeFrosneResultatKilder(frosne);
        }
      }
      // Lookup, merge and write all happen against the same fresh read: the
      // prosessbygger sends the whole prosess, so a merge onto a stale copy
      // would silently undo whatever the other save had just added.
      const oppdatertProsess = await updateProsesskatalog((katalog) => {
        const plassering = findProsessIKatalog(katalog, parametere.prosessId);
        if (!plassering) {
          throw new HttpError("Fant ikke prosess.", 404);
        }
        const { liste, indeks } = plassering;
        const eksisterende = liste[indeks];
        const ny = normalizeProsess({
          ...eksisterende,
          navn: body.navn ?? eksisterende.navn,
          beskrivelse: body.beskrivelse ?? eksisterende.beskrivelse,
          versjon: body.versjon ?? eksisterende.versjon,
          steg: Array.isArray(body.steg) ? body.steg : eksisterende.steg,
          redigering: body.redigering ? { ...eksisterende.redigering, ...body.redigering } : eksisterende.redigering,
          syntetisk: true
        });
        liste[indeks] = ny;
        return ny;
      });
      await addRevisjon({
        sporingsId: newId("flyt"),
        handling: "PROSESS_OPPDATERT",
        ressurs: "prosess",
        aktor: { type: "utvikler", id: "prosessbygger" }
      });
      jsonResponse(response, 200, oppdatertProsess);
    }
  },
  {
    metode: "POST",
    sti: "/api/prosessoekter",
    // You may start a process for yourself. The subject is in the body.
    finnPersonId: personIdFromBody,
    handter: async ({ request, response, tilstand, kaller }) => {
      const body = await readBodyOnce(request);
      const prosess = tilstand.prosesser.find((kandidat: any) => kandidat.id === body.prosessId) || null;
      const person = findPerson(tilstand, body.personId);
      if (!prosess || !person) {
        jsonResponse(response, 404, { feil: "Fant ikke prosess eller person." });
        return;
      }
      // Being the party to a case is not the same as being able to send one. A
      // three-year-old is a party to their own kindergarten application; the parent
      // is the sender. The sandbox listed all 394 test people as ID-porten users,
      // 65 of them under 13, so this was reachable - and everything downstream
      // (consent, audit, purpose limitation) rests on the sender being someone who
      // may answer.
      const handleevne = vurderHandleevne(person, tilstand.satser.gjelderFra);
      const representanter = finnRepresentanter(
        { personer: tilstand.personer },
        person.personId,
        tilstand.satser.gjelderFra
      );
      const kallerErRepresentant =
        kaller.type === "system" ||
        (kaller.type === "innbygger" &&
          representantPider(tilstand, person.personId, tilstand.satser.gjelderFra)
            .includes(kaller.pid));
      if (!handleevne.kanOpptreSelv && !kallerErRepresentant) {
        throw manglerHandleevne(forklarHandleevne(handleevne, representanter));
      }
      const newSession: Prosessoekt = {
        oektsId: newId("oekt"),
        prosessId: prosess.id,
        personId: person.personId,
        sporingsId: body.sporingsId || newId("flyt"),
        status: "AKTIV",
        stegIndex: 0,
        svar: {},
        resultaterRaa: {},
        resultatKilder: {},
        resultatKilderFrosset: true,
        aktivtSamtykkeId: null,
        opprettet: new Date().toISOString(),
        oppdatert: new Date().toISOString(),
        syntetisk: true
      };
      tilstand.prosessoekter.push(newSession);
      await lagreProsessoekt(newSession);
      await addRevisjon({
        sporingsId: newSession.sporingsId,
        handling: "PROSESSOEKT_OPPRETTET",
        ressurs: "prosessoekt",
        aktor: aktorFor(kaller, newSession.personId)
      });
      jsonResponse(response, 201, buildProsessoektRespons(newSession, prosess, {}));
    }
  },
  {
    metode: "GET",
    sti: "/api/prosessoekter/:oektsId",
    finnPersonId: eierAvOekt,
    // A read: closed økter stay readable, and nothing is stamped or saved.
    handter: (kontekst) =>
      withSession(kontekst, { lesing: true }, () => {})
  },
  {
    metode: "POST",
    sti: "/api/prosessoekter/:oektsId/svar",
    finnPersonId: eierAvOekt,
    handter: (kontekst) => withSession(kontekst, {
      afterSave: (session) => addRevisjon({
        sporingsId: session.sporingsId,
        handling: "STEG_SVAR_LAGRET",
        ressurs: "prosessoekt",
        aktor: aktorFor(kontekst.kaller, session.personId)
      })
    }, async (session, prosess) => {
      const body = await readBodyOnce(kontekst.request);
      const steg = prosess.steg[session.stegIndex];
      if (!steg) {
        throw new HttpError("Fant ikke aktivt steg.", 400);
      }
      const stegId = body.stegId || steg.id;
      if (stegId !== steg.id) {
        throw new HttpError("Svar kan bare lagres på det aktive steget.", 400);
      }
      if (steg.type !== "QUESTION") {
        throw new HttpError("Svar kan bare lagres på spørsmålssteg.", 400);
      }
      lagreStegSvar(session, prosess, steg, body.svar);
    })
  },
  {
    metode: "POST",
    sti: "/api/prosessoekter/:oektsId/handling",
    finnPersonId: eierAvOekt,
    handter: (kontekst) => withSession(kontekst, { underSteghandling: true },
      async (session, prosess, checkpoint, currentState) => {
        const body = await readBodyOnce(kontekst.request);
        const steg = prosess.steg[session.stegIndex];
        if (!steg) {
          throw new HttpError("Fant ikke aktivt steg.", 400);
        }
        invalidateStegOgSenere(session, prosess, steg);
        await checkpoint();
        return runStegHandling(currentState, session, prosess, body, kontekst.kaller);
      }
    )
  },
  {
    metode: "POST",
    sti: "/api/prosessoekter/:oektsId/neste",
    finnPersonId: eierAvOekt,
    handter: (kontekst) => withSession(kontekst, {}, (session, prosess, _checkpoint, currentState) => {
      if (session.stegIndex >= prosess.steg.length - 1) {
        throw new HttpError("Prosessøkten er allerede på siste steg.", 400);
      }
      const steg = prosess.steg[session.stegIndex];
      const { resultater } = resultaterNaa(
        currentState,
        session,
        prosess
      );
      if (!steg || !erStegFullfort(session, steg, resultater)) {
        throw new HttpError("Det aktive steget må fullføres før prosessen kan gå videre.", 400);
      }
      session.stegIndex += 1;
    })
  },
  {
    metode: "POST",
    sti: "/api/prosessoekter/:oektsId/forrige",
    finnPersonId: eierAvOekt,
    handter: (kontekst) => withSession(kontekst, {}, (session) => {
      if (session.stegIndex <= 0) {
        throw new HttpError("Prosessøkten er allerede på første steg.", 400);
      }
      session.stegIndex -= 1;
    })
  },
  {
    /*
     * Kommunens varslingsjobb, som HTTP.
     *
     * `tilgang: "bred"` og et eget scope: dette er ikke en innbygger som gjør noe
     * med sine egne data, det er kommunen som sender en melding til mange. En
     * ID-porten-innlogging skal ikke kunne utløse den, og et lesetoken heller ikke.
     *
     * Samme kodevei som `scripts/varsle-seniorsirkel.ts` - `kjoerVarsling` er den
     * ene implementasjonen, og dette er den andre inngangen til den.
     * `?torrkjor=true` regner ut utvalget og sender ingenting.
     */
    metode: "POST",
    sti: "/api/varsel/seniorsirkel/kjor",
    tilgang: "bred",
    scope: SCOPE_VARSLING,
    finnPersonId: () => null,
    handter: async ({ response, tilstand, url }) => {
      jsonResponse(response, 200, {
        ...(await kjoerVarsling(tilstand, {
          sporingsId: getSporingsId(url),
          torrkjoer: url.searchParams.get("torrkjor") === "true"
        })),
        syntetisk: true
      });
    }
  },
  {
    /*
     * Ledgeren, lest.
     *
     * Den *utleder ikke* kandidater, og det er med vilje: å lese befolkningen for
     * å avgjøre hvem som skal kontaktes er behandlingen som trenger en hjemmel, og
     * den føres hver gang den skjer. Å åpne en statusside er ikke den behandlingen.
     * Vil du ha kandidatlisten, kall `kjor?torrkjor=true` - den logger, som den skal.
     */
    metode: "GET",
    sti: "/api/varsel/seniorsirkel/utsendinger",
    tilgang: "bred",
    scope: SCOPE_VARSLING,
    finnPersonId: () => null,
    handter: async ({ response, url }) => {
      const personId = url.searchParams.get("personId");
      const alle = await lesUtsendinger();
      const utsendinger = personId ? alle.filter((rad) => rad.personId === personId) : alle;
      jsonResponse(response, 200, {
        hjemmel: VARSELHJEMMEL,
        utsendinger,
        antall: utsendinger.length,
        syntetisk: true
      });
    }
  },
  {
    /**
     * Hvilken kanal denne personen ville fått et varsel på, uten å sende noe.
     *
     * `kanBrev` sier om personen hører til brev-sporet: ingen digital
     * varselkanal (reservert, ukjent i registeret eller ingen
     * kontaktopplysning) OG en postadresse SvarUt faktisk kan bruke.
     * `person-404`-scenarioet (streng fortrolig adresse + reservert) faller
     * riktig ut her, sjøl om `grunn` er `reservert`: skjermingen har alt
     * nullet adressen hans, og `harGyldigPostadresse` under leser den
     * allerede maskerte personen, ikke registeret på nytt.
     */
    metode: "GET",
    sti: "/api/varsel/seniorsirkel/kanal/:personId",
    tilgang: "bred",
    scope: SCOPE_VARSLING,
    finnPersonId: () => null,
    handter: async ({ response, parametere, tilstand }) => {
      const person = tilstand.personer.find((kandidat: any) => kandidat.personId === parametere.personId);
      if (!person) {
        throw new HttpError("Fant ikke personen.", 404);
      }
      const info = await hentKanalinfo(person);
      jsonResponse(response, 200, {
        personId: person.personId,
        kanal: info.kanal,
        ...(info.grunn ? { grunn: info.grunn } : {}),
        kanBrev: info.kanBrev,
        syntetisk: true
      });
    }
  },
  {
    /**
     * Steg 1 i varsel-SMS-veiviseren: en kunngjøring uten samtykke, uten
     * personalisering utover en varm åpningssetning KI-en skriver. Ingen
     * port her - alle kan få vite at portalen finnes.
     */
    metode: "POST",
    sti: "/api/varsel/seniorsirkel/sms/kunngjoring",
    tilgang: "bred",
    scope: SCOPE_VARSLING,
    finnPersonId: () => null,
    handter: async ({ request, response, tilstand, url }) => {
      const body = await readBodyOnce(request);
      const person = tilstand.personer.find((kandidat: any) => kandidat.personId === body?.personId);
      if (!person) {
        throw new HttpError("personId er påkrevd og må finnes.", 400);
      }
      const sporingsId = getSporingsId(url);
      const katalog = await hentAktivitetskatalog();
      const svar = await tryUpstream<any>(
        { service: "KI-tjenesten", action: "Å skrive kunngjørings-SMS-en" },
        () => fetch(`${aiBaseUrl}/ai/personlig-sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sporingsId,
            sprak: "nb",
            kontekst: {
              ramme: "kunngjoring",
              fornavn: person.navn.fornavn,
              kommunenavn: katalog.kommunenavn,
              lenke: "«min side» i innbyggerportalen",
              telefon: finnKommunetelefon(katalog),
              forslag: []
            }
          })
        })
      );
      if (!svar.ok) {
        throw svar.error;
      }
      const kandidat = { personId: person.personId, varseltype: "portal-kunngjoring" as const };
      const nyRad = await sendEnkeltvarsel({
        ...kandidat,
        fnr: person.syntetiskFodselsnummer,
        tekst: svar.data.tekst
      }, { sporingsId, hjemmel: VARSELHJEMMEL });
      // nyRad er null når nøkkelen alt fantes - da har vi nettopp bedt KI-en om
      // en ny tekst uten å sende den, og svar.data.tekst er derfor IKKE det som
      // faktisk gikk ut. Den historiske teksten står i Fiks' utboks, ikke her -
      // se GET .../utsendinger + GET /fiks/varsler, samme oppslag som Oversikt-
      // fanens logg allerede gjør.
      jsonResponse(response, 200, {
        personId: person.personId,
        ...(nyRad ? { tekst: svar.data.tekst, kilde: svar.data.kilde } : {}),
        ...(svar.data.advarsel && nyRad ? { advarsel: svar.data.advarsel } : {}),
        utsending: nyRad ?? await finnEksisterendeUtsending(kandidat),
        alleredeSendt: !nyRad,
        sporingsId,
        syntetisk: true
      });
    }
  },
  {
    /**
     * Steg 2 og 4 i varsel-SMS-veiviseren: en personlig SMS om tilbud som
     * skårer høyt for henne, sperret bak samtykke - se
     * SENIORSIRKEL_KONTAKT_HJEMMEL i varsling.ts for hvorfor grunnlaget
     * skifter her, og ikke for kunngjøringen over.
     */
    metode: "POST",
    sti: "/api/varsel/seniorsirkel/sms/tilbud",
    tilgang: "bred",
    scope: SCOPE_VARSLING,
    finnPersonId: () => null,
    handter: async ({ request, response, tilstand, url }) => {
      const body = await readBodyOnce(request);
      const person = tilstand.personer.find((kandidat: any) => kandidat.personId === body?.personId);
      if (!person) {
        throw new HttpError("personId er påkrevd og må finnes.", 400);
      }
      const samtykke = await finnGjeldendeSeniorsirkelSamtykke(person.personId);
      if (samtykke?.status !== "SAMTYKKET") {
        throw new HttpError(
          "Personen har ikke samtykket til personlig kontakt om seniortilbud.", 403);
      }
      const ramme = body?.ramme === "oppfolging" ? "tilbud-oppfolging" : "tilbud-forstegang";
      const visning = await portalvisning(person);
      const forslag = visning.anbefalte.slice(0, 3).map((rad) => ({ navn: rad.navn }));
      const sporingsId = getSporingsId(url);
      const katalog = await hentAktivitetskatalog();
      const svar = await tryUpstream<any>(
        { service: "KI-tjenesten", action: "Å skrive tilbuds-SMS-en" },
        () => fetch(`${aiBaseUrl}/ai/personlig-sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sporingsId,
            sprak: "nb",
            kontekst: {
              ramme,
              fornavn: person.navn.fornavn,
              kommunenavn: katalog.kommunenavn,
              lenke: "«min side» i innbyggerportalen",
              telefon: finnKommunetelefon(katalog),
              forslag
            }
          })
        })
      );
      if (!svar.ok) {
        throw svar.error;
      }
      const kandidat = {
        personId: person.personId,
        varseltype: "tilbud-finnes" as const,
        tilbudId: forslag.length > 0 ? visning.anbefalte[0]!.tilbudId : undefined
      };
      const nyRad = await sendEnkeltvarsel({
        ...kandidat,
        fnr: person.syntetiskFodselsnummer,
        tekst: svar.data.tekst
      }, { sporingsId, hjemmel: SENIORSIRKEL_KONTAKT_HJEMMEL });
      // Samme begrunnelse som i sms/kunngjoring over: et null-svar betyr at
      // nøkkelen alt fantes, og svar.data.tekst er da bare det KI-en skrev nå -
      // ikke det som faktisk gikk ut.
      jsonResponse(response, 200, {
        personId: person.personId,
        ...(nyRad ? { tekst: svar.data.tekst, kilde: svar.data.kilde } : {}),
        ...(svar.data.advarsel && nyRad ? { advarsel: svar.data.advarsel } : {}),
        utsending: nyRad ?? await finnEksisterendeUtsending(kandidat),
        alleredeSendt: !nyRad,
        sporingsId,
        syntetisk: true
      });
    }
  },
  {
    /** Steg 1 i varsel-brev-veiviseren: kun utkastet, ingen sending og ingen ledgerrad ennå. */
    metode: "POST",
    sti: "/api/varsel/seniorsirkel/brev/utkast",
    tilgang: "bred",
    scope: SCOPE_VARSLING,
    finnPersonId: () => null,
    handter: async ({ request, response, tilstand, url }) => {
      const body = await readBodyOnce(request);
      const person = tilstand.personer.find((kandidat: any) => kandidat.personId === body?.personId);
      if (!person) {
        throw new HttpError("personId er påkrevd og må finnes.", 400);
      }
      if (!erBrevtype(body?.brevtype)) {
        throw new HttpError(`brevtype må være en av: aapning, oppfolging.`, 400);
      }
      const brevtype = body.brevtype as Brevtype;
      const info = await hentKanalinfo(person);
      if (!info.kanBrev) {
        throw new HttpError(
          "Personen har en digital varselkanal, eller ingen gyldig postadresse - hører ikke til brevsporet.",
          400
        );
      }
      const visning = await portalvisning(person);
      const sporingsId = getSporingsId(url);
      const katalog = await hentAktivitetskatalog();
      const hendelser = brevtype === "oppfolging"
        ? (await hentPortalregistreringer(person.personId)).slice(0, 3)
          .map((rad) => ({ navn: rad.navn, grunnlag: "paameldt" as const }))
        : [];
      const svar = await tryUpstream<any>(
        { service: "KI-tjenesten", action: "Å skrive brevavsnittene" },
        () => fetch(`${aiBaseUrl}/ai/personlig-brev`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sporingsId,
            sprak: "nb",
            kontekst: {
              brevtype,
              fornavn: person.navn.fornavn,
              kommunenavn: katalog.kommunenavn,
              telefon: finnKommunetelefon(katalog),
              forslag: brevtype === "aapning"
                ? visning.anbefalte.slice(0, 3).map((rad) => ({ navn: rad.navn, kategori: rad.kategori }))
                : [],
              hendelser
            }
          })
        })
      );
      if (!svar.ok) throw svar.error;
      jsonResponse(response, 200, {
        personId: person.personId,
        brevtype,
        avsnitt: svar.data.avsnitt,
        kilde: svar.data.kilde,
        ...(svar.data.advarsel ? { advarsel: svar.data.advarsel } : {}),
        sporingsId,
        syntetisk: true
      });
    }
  },
  {
    /** Steg 2 og 3 i varsel-brev-veiviseren: brevet, sendt, med utkastets avsnitt om ikke oppgitt på nytt. */
    metode: "POST",
    sti: "/api/varsel/seniorsirkel/brev",
    tilgang: "bred",
    scope: SCOPE_VARSLING,
    finnPersonId: () => null,
    handter: async ({ request, response, tilstand, url }) => {
      const body = await readBodyOnce(request);
      const person = tilstand.personer.find((kandidat: any) => kandidat.personId === body?.personId);
      if (!person) {
        throw new HttpError("personId er påkrevd og må finnes.", 400);
      }
      if (!erBrevtype(body?.brevtype)) {
        throw new HttpError(`brevtype må være en av: aapning, oppfolging.`, 400);
      }
      const brevtype = body.brevtype as Brevtype;
      const avsnitt: string[] = Array.isArray(body?.avsnitt)
        ? body.avsnitt.filter((linje: unknown): linje is string => typeof linje === "string")
        : [];
      if (avsnitt.length === 0) {
        throw new HttpError("avsnitt er påkrevd - kall .../brev/utkast først.", 400);
      }
      const kilde = body?.kilde === "regel" ? "regel" as const : "modell" as const;
      const katalog = await hentAktivitetskatalog();
      const visning = await portalvisning(person);
      const innhold = byggBrevinnhold({
        person,
        brevtype,
        kommunenavn: katalog.kommunenavn,
        avsnitt,
        punkter: visning.anbefalte.slice(0, 4).map((rad) => rad.navn),
        telefon: finnKommunetelefon(katalog),
        dato: brevdato()
      });
      const sporingsId = getSporingsId(url);
      const rad = await sendBrev(person, brevtype, innhold.overskrift, { avsnitt, kilde }, sporingsId);
      if (!rad) {
        throw new HttpError(`Dette brevet er allerede sendt til ${person.navn.fornavn}.`, 409);
      }
      jsonResponse(response, 200, { ...rad, syntetisk: true });
    }
  },
  {
    metode: "GET",
    sti: "/api/varsel/seniorsirkel/brev/:brevtype/:personId",
    tilgang: "bred",
    scope: SCOPE_VARSLING,
    finnPersonId: () => null,
    handter: async ({ response, parametere }) => {
      if (!erBrevtype(parametere.brevtype)) {
        throw new HttpError(`brevtype må være en av: aapning, oppfolging.`, 400);
      }
      const rad = await lesBrevrad(parametere.personId, parametere.brevtype as Brevtype);
      if (!rad) {
        throw new HttpError("Fant ingen sendt brev for denne personen og brevtypen.", 404);
      }
      const status = rad.forsendelseId ? await readForsendelsesstatus(rad.forsendelseId) : null;
      jsonResponse(response, 200, { ...rad, ...(status ? { status: status.status } : {}), syntetisk: true });
    }
  },
  {
    /** PDF-en, tegnet på nytt fra ledgerens avsnitt hver gang - se brev.ts. */
    metode: "GET",
    sti: "/api/varsel/seniorsirkel/brev/:brevtype/:personId/pdf",
    tilgang: "bred",
    scope: SCOPE_VARSLING,
    finnPersonId: () => null,
    handter: async ({ response, parametere, tilstand }) => {
      if (!erBrevtype(parametere.brevtype)) {
        throw new HttpError(`brevtype må være en av: aapning, oppfolging.`, 400);
      }
      const brevtype = parametere.brevtype as Brevtype;
      const rad = await lesBrevrad(parametere.personId, brevtype);
      if (!rad) {
        throw new HttpError("Fant ingen sendt brev for denne personen og brevtypen.", 404);
      }
      const person = tilstand.personer.find((kandidat: any) => kandidat.personId === parametere.personId);
      if (!person) {
        throw new HttpError("Fant ikke personen.", 404);
      }
      const katalog = await hentAktivitetskatalog();
      const visning = await portalvisning(person);
      const innhold = byggBrevinnhold({
        person,
        brevtype,
        kommunenavn: katalog.kommunenavn,
        avsnitt: rad.avsnitt,
        punkter: visning.anbefalte.slice(0, 4).map((tilbud) => tilbud.navn),
        telefon: finnKommunetelefon(katalog),
        dato: brevdato()
      });
      const pdf = await renderBrevPdf(innhold);
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${brevtype}-${parametere.personId}.pdf"`,
        ...cors()
      });
      response.end(pdf);
    }
  },
  {
    metode: "POST",
    sti: "/api/soknader",
    finnPersonId: personIdFromBody,
    handter: async ({ request, response, kaller }) => {
      const body = await readBodyOnce(request);
      jsonResponse(response, 201, await createSoknad(body, kaller));
    }
  },
  {
    metode: "GET",
    sti: "/api/soknader/:soknadId",
    finnPersonId: eierAvSoknad,
    handter: ({ response, parametere, tilstand }) => {
      const soknad = tilstand.soknader.find((kandidat: any) => kandidat.soknadId === parametere.soknadId);
      jsonResponse(response, soknad ? 200 : 404, soknad || { feil: "Fant ikke søknad." });
    }
  },
  {
    /*
     * A thin proxy in front of SvarUt' status-sok, and the reason it exists is
     * the token: the browser holds an ID-porten token for the citizen, and the
     * SvarUt surface takes Maskinporten only. This route is where the
     * municipality's hjemmel meets the citizen's - authorised as the søknad's
     * owner, then asked for on the machine's token.
     *
     * It answers about one forsendelse, the one this søknad's kvittering was
     * sent as. A søknad the citizen does not own is not reachable here, and
     * neither is a forsendelseId they simply guessed.
     */
    metode: "GET",
    sti: "/api/soknader/:soknadId/forsendelse",
    finnPersonId: eierAvSoknad,
    handter: async ({ response, parametere, tilstand }) => {
      const soknad = tilstand.soknader.find((kandidat: any) => kandidat.soknadId === parametere.soknadId);
      if (!soknad) {
        throw new HttpError("Fant ikke søknad.", 404);
      }
      // No forsendelseId is the ordinary case for a søknad from POST
      // /api/soknader, and for one whose kvittering degraded into an advarsel.
      // Neither is an error the citizen made, so the answer says which it is.
      if (!soknad.forsendelseId) {
        throw new HttpError("Søknaden har ingen SvarUt-forsendelse.", 404);
      }
      const status = await readForsendelsesstatus(soknad.forsendelseId);
      if (!status) {
        throw new HttpError("SvarUt kjenner ikke forsendelsen.", 404);
      }
      jsonResponse(response, 200, { ...status, syntetisk: true });
    }
  },
  {
    metode: "GET",
    // The whole log, across every person. No citizen token can justify that,
    // however high the acr.
    tilgang: "bred",
    sti: "/api/revisjonslogg",
    handter: ({ response, tilstand }) => {
      jsonResponse(response, 200, tilstand.revisjonslogg);
    }
  },
  {
    // Used by fiks-simulator and ai-gateway so this service stays the only writer.
    // Writing an audit event is its own hjemmel, separate from reading person data.
    metode: "POST",
    tilgang: "bred",
    scope: SCOPE_REVISJON,
    sti: "/api/revisjonslogg",
    handter: async ({ request, response }) => {
      const hendelse = await readBodyOnce(request);
      if (!hendelse.handling) {
        jsonResponse(response, 400, { feil: "Revisjonshendelse mangler handling." });
        return;
      }
      await addRevisjon(hendelse);
      jsonResponse(response, 201, { status: "registrert", syntetisk: true });
    }
  },
  {
    metode: "GET",
    sti: "/api/revisjonslogg/:sporingsId",
    // One sporingsId is one flow. A citizen may read their own - that is the
    // transparency surface demo-gui renders - so the subject is whoever the flow
    // was about. A flow with no person in it is open to any authenticated caller.
    finnPersonId: ({ parametere, tilstand }) =>
      tilstand.prosessoekter.find((session: any) => session.sporingsId === parametere.sporingsId)?.personId
      ?? tilstand.soknader.find((s: any) => s.sporingsId === parametere.sporingsId)?.personId
      ?? null,
    handter: ({ response, parametere, tilstand }) => {
      jsonResponse(response, 200, tilstand.revisjonslogg.filter((rad: any) => rad.sporingsId === parametere.sporingsId));
    }
  }
];

// Patterns are compiled once at module load, not per request.
const kompilerte = [...systemruter, ...ruter].map((rute) => ({
  rute,
  monster: compilePathPattern(rute.sti)
}));

function findRoute(metode: string, sti: string): { rute: Rute; parametere: PathParams } | null {
  for (const { rute, monster } of kompilerte) {
    if (rute.metode !== metode) continue;
    const parametere = matchPath(monster, sti);
    if (parametere) {
      return { rute, parametere };
    }
  }
  return null;
}

// Formålet gjenlesingsradene bærer, brukt både når de skrives og når de telles.
const GJENLESING = "Gjenlesing av prosessøkt";

const systemPaths = new Set(systemruter.map((rute) => rute.sti));

export async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url!, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    jsonResponse(response, 204, {});
    return;
  }

  try {
    const treff = findRoute(request.method!, url.pathname);

    // System routes answer without state, so /helse still works if a dataset
    // is corrupt. They also answer without a token: a health probe that needs
    // credentials cannot tell you the service is unhealthy.
    if (treff && systemPaths.has(treff.rute.sti)) {
      await treff.rute.handter({
        request, response, url, parametere: treff.parametere,
        // The cast states the invariant rather than guessing at it: these are
        // exactly the routes in systemPaths, and they are the only handlers that
        // never touch tilstand - which is the whole reason they are called before
        // readState(). Widening Kontekst.tilstand to `State | null` instead would
        // push a null check into all forty handlers to describe five.
        tilstand: null as unknown as State,
        kaller: { type: "anonym" }
      });
      return;
    }

    // Once per request, before anything reads state. A broken token is a 401 here
    // and never reaches a handler; a missing one is `anonym`, and what that is
    // worth is decided per route and per resource.
    const kaller = await classifyKaller(request);

    const tilstand = await readState();

    if (treff) {
      const routeContext = { request, response, url, parametere: treff.parametere, tilstand };
      const personId = treff.rute.finnPersonId
        ? await treff.rute.finnPersonId(routeContext)
        : null;

      try {
        requireTilgang({
          kaller,
          tilgang: treff.rute.tilgang ?? "egne-data",
          scope: treff.rute.scope ?? SCOPE_LES,
          // A subject we cannot resolve - an unknown oektsId, say - leaves pid null,
          // and the handler then answers 404. Refusing with 403 instead would tell
          // an unauthenticated caller which session ids exist.
          pid: personId
            ? findPerson(tilstand, personId)?.syntetiskFodselsnummer ?? null
            : null,
          representantPider: personId
            ? representantPider(tilstand, personId, tilstand.satser.gjelderFra)
            : [],
          hva: `${treff.rute.metode} ${treff.rute.sti}`
        });
      } catch (feil) {
        await addRevisjon({
          sporingsId: getSporingsId(url),
          handling: "TILGANG_NEKTET",
          ressurs: treff.rute.sti,
          formaal: "Mangler hjemmel",
          ...(personId ? { gjaldt: personId } : {}),
          aktor: aktorFor(kaller, personId)
        });
        throw feil;
      }

      await treff.rute.handter({ ...routeContext, kaller });
      return;
    }

    // No orchestration route matched: try the shared resource catalog, which the
    // process engine consults in exactly the same way.
    if (findRessurs(request.method!, url.pathname)) {
      const data = await runRessurs(tilstand, request.method!, url, {
        sporingsId: getSporingsId(url),
        kaller
      });
      jsonResponse(response, 200, data);
      return;
    }

    jsonResponse(response, 404, { feil: "Fant ikke endepunkt." });
  } catch (error) {
    jsonResponse(response, statusFor(error), errorBody(error), headersFor(error));
  }
}

export { HttpError, ruter, systemruter };
