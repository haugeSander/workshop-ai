/*
 * Brevet: innholdet, PDF-en det blir til, og sendingen.
 *
 * Delt som forsendelse.ts og chooseKanal: byggBrevinnhold og renderBrevPdf er
 * rene av HTTP - ingen fetch, ingen state - så de kan pinnes mot en literal
 * fixture uten en eneste tjeneste oppe. sendBrev og sendBrevforsendelse er
 * I/O-halvdelen.
 *
 * **Sendingen gjenbruker SvarUt-sporet** (svarut.ts, forsendelse.ts i
 * fiks-simulator) framfor å finne opp et tredje kanalvalg og en tredje
 * statusmaskin. Mottakerkretsen her er, per konstruksjon, nøyaktig den
 * `chooseKanal` ville falt til PRINT for - ingen digital kanal i
 * kontaktregisteret, men en gyldig postadresse - så det er det samme
 * spørsmålet begge steder, ikke et nytt ett.
 *
 * PDF-bytene lagres aldri: samme konvensjon som forsendelse.ts sin
 * "simulatoren lagrer aldri dokumentbytes". `GET .../pdf` tegner alltid brevet
 * på nytt av det ledgeren husker - avsnittene modellen skrev - så en re-lesing
 * aldri kan avvike fra det som faktisk ble sendt.
 */
import PDFDocument from "pdfkit";
import { maskinportenHeader } from "../../digdir-mock/src/client.ts";
import { fiksBaseUrl, fiksSvarutToken, svarutKontoId } from "./config.ts";
import { fulltNavn, postadresseFor } from "./kvittering.ts";
import type { Person } from "../../shared/innbyggerdata.ts";
import type { Brevtype } from "../../shared/brev.ts";
import { readJson, updateJson } from "../../shared/jsonstore.ts";
import { buildAdvarsel, tryUpstream, type Advarsel } from "./upstream.ts";

const forsendelserUrl = `${fiksBaseUrl}/svarut/api/v2/kontoer/${svarutKontoId}/forsendelser`;

export type Brevinnhold = {
  mottaker: { navn: string; adresselinje1?: string; postnummer?: string; poststed?: string };
  kommunenavn: string;
  dato: string;
  overskrift: string;
  avsnitt: string[];
  punkter: string[];
  telefon: string;
};

const OVERSKRIFT: Record<Brevtype, string> = {
  aapning: "Vi har lyst til å møte deg. Bli med på aktiviteter som passer deg!",
  oppfolging: "Litt nytt om tilbudene dine"
};

/** Brevinnholdet, satt sammen av kjente fakta og modellens avsnitt. Modellen skriver aldri resten. */
export function byggBrevinnhold(felles: {
  person: Person;
  brevtype: Brevtype;
  kommunenavn: string;
  avsnitt: string[];
  punkter: string[];
  telefon: string;
  dato: string;
}): Brevinnhold {
  return {
    mottaker: { navn: fulltNavn(felles.person), ...postadresseFor(felles.person) },
    kommunenavn: felles.kommunenavn,
    dato: felles.dato,
    overskrift: OVERSKRIFT[felles.brevtype],
    avsnitt: felles.avsnitt,
    punkter: felles.punkter,
    telefon: felles.telefon
  };
}

/**
 * PDF-en, tegnet med pdfkit.
 *
 * Ingen logofil er lagt ved: våpenskjoldet er vektorprimitiver. Sandkassen
 * eier ikke Ringerike kommunes logo, og en ekte kommune som tar dette i bruk
 * legger inn sin egen - samme grunn som portalens `#kommunevaapen` står skjult
 * til noen gjør det.
 */
export function renderBrevPdf(innhold: Brevinnhold): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const dokument = new PDFDocument({ size: "A4", margin: 56 });
    const biter: Buffer[] = [];
    dokument.on("data", (bit: Buffer) => biter.push(bit));
    dokument.on("end", () => resolve(Buffer.concat(biter)));
    dokument.on("error", reject);

    dokument.save();
    dokument.roundedRect(56, 48, 34, 40, 8).fill("#c8102e");
    dokument.circle(73, 66, 9).lineWidth(2).stroke("#f2c94c");
    dokument.restore();
    dokument.fillColor("#1a1a1a").fontSize(14).font("Helvetica-Bold")
      .text(innhold.kommunenavn.toUpperCase(), 100, 56, { characterSpacing: 1 });
    dokument.font("Helvetica").fontSize(9).fillColor("#555")
      .text("KOMMUNE", 100, 74, { characterSpacing: 2 });

    dokument.fillColor("#1a1a1a").font("Helvetica").fontSize(11);
    dokument.text(innhold.mottaker.navn, 56, 150);
    if (innhold.mottaker.adresselinje1) dokument.text(innhold.mottaker.adresselinje1);
    if (innhold.mottaker.postnummer || innhold.mottaker.poststed) {
      dokument.text(`${innhold.mottaker.postnummer ?? ""} ${innhold.mottaker.poststed ?? ""}`.trim());
    }
    dokument.fontSize(10).text(`Dato: ${innhold.dato}`, 56, 150, { align: "right" });

    dokument.moveDown(4);
    dokument.font("Helvetica-Bold").fontSize(13).text(innhold.overskrift);
    dokument.moveDown();

    dokument.font("Helvetica").fontSize(11);
    for (const avsnitt of innhold.avsnitt) {
      dokument.text(avsnitt);
      dokument.moveDown();
    }

    if (innhold.punkter.length > 0) {
      dokument.font("Helvetica-Bold").text("Eksempel på aktiviteter du kan delta på:");
      dokument.font("Helvetica");
      for (const punkt of innhold.punkter) {
        dokument.text(`-  ${punkt}`, { indent: 14 });
      }
      dokument.moveDown();
    }

    dokument.font("Helvetica-Bold").text(`Ønsker du å snakke med noen? Ring oss på ${innhold.telefon}.`);
    dokument.moveDown(2);
    dokument.font("Helvetica").text("Med vennlig hilsen");
    dokument.font("Helvetica-Bold").text(`${innhold.kommunenavn} kommune`);

    dokument.fontSize(8).fillColor("#777").text(
      "Internt dokument - generert i en demosandkasse, ikke et ekte kommunalt brev.",
      56,
      dokument.page.height - 60,
      { width: dokument.page.width - 112, align: "center" }
    );

    dokument.end();
  });
}

/** Én rad i brev-ledgeren. Nøkkelen er unik per person og brevtype - se brevnoekkel. */
export type Brevrad = {
  noekkel: string;
  personId: string;
  brevtype: Brevtype;
  forsendelseId?: string;
  /** Modellens avsnitt, slik de faktisk ble sendt. GET .../pdf tegner ut fra disse, aldri på nytt. */
  avsnitt: string[];
  kilde: "modell" | "regel";
  status: "paabegynt" | "sendt" | "feilet";
  sporingsId: string;
  feil?: string;
  opprettet: string;
};

/** Ett brev sendes én gang per person: en oppfølgingsrunde er en ny brevtype, ikke en ny nøkkel. */
export function brevnoekkel(personId: string, brevtype: Brevtype): string {
  return `${brevtype}:${personId}`;
}

export async function lesBrevrad(personId: string, brevtype: Brevtype): Promise<Brevrad | null> {
  const rader = (await readJson("seniorsirkel-brev.json", [])) as Brevrad[];
  return rader.find((rad) => rad.noekkel === brevnoekkel(personId, brevtype)) ?? null;
}

async function sendBrevforsendelse(
  person: Person,
  brevtype: Brevtype,
  overskrift: string,
  sporingsId: string
): Promise<{ ok: true; forsendelseId?: string } | { ok: false; advarsel: Advarsel }> {
  const svar = await tryUpstream<{ id?: string }>(
    { service: "Fiks-simulatoren", action: "Å sende brevet på SvarUt" },
    async () => fetch(forsendelserUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await maskinportenHeader(fiksSvarutToken)) },
      body: JSON.stringify({
        tittel: overskrift,
        mottaker: {
          navn: fulltNavn(person),
          digitalId: person.syntetiskFodselsnummer,
          ...postadresseFor(person)
        },
        dokumenter: [{ filnavn: `${brevtype}.pdf`, mimeType: "application/pdf" }],
        avgivendeSystem: "sandbox-backend",
        eksternReferanse: `${brevnoekkel(person.personId, brevtype)}:${sporingsId}`
      })
    })
  );
  if (!svar.ok) {
    return { ok: false, advarsel: buildAdvarsel("Brevet ble ikke sendt på SvarUt.", svar.error.message) };
  }
  return { ok: true, forsendelseId: svar.data?.id };
}

/**
 * Ett brev, gjennom ledgeren.
 *
 * Samme klemme-før-sending som sendEnkeltvarsel i varsling.ts: nøkkelen tas
 * inne i køen før Fiks kalles, så to samtidige forsøk på samme brev ikke begge
 * kan se «ikke sendt ennå» og begge sende.
 *
 * Svarer `null` når nøkkelen allerede fantes. Det er ikke en feil - det er
 * ledgeren som gjør jobben sin.
 */
export async function sendBrev(
  person: Person,
  brevtype: Brevtype,
  overskrift: string,
  tekst: { avsnitt: string[]; kilde: "modell" | "regel" },
  sporingsId: string
): Promise<Brevrad | null> {
  const noekkel = brevnoekkel(person.personId, brevtype);
  const klemt: boolean = await updateJson(
    "seniorsirkel-brev.json", [], (rader: Brevrad[]) => {
      if (rader.some((rad) => rad.noekkel === noekkel)) return false;
      rader.push({
        noekkel,
        personId: person.personId,
        brevtype,
        avsnitt: tekst.avsnitt,
        kilde: tekst.kilde,
        status: "paabegynt",
        sporingsId,
        opprettet: new Date().toISOString()
      });
      return true;
    });
  if (!klemt) return null;

  const utfall = await sendBrevforsendelse(person, brevtype, overskrift, sporingsId);
  return updateJson("seniorsirkel-brev.json", [], (rader: Brevrad[]) => {
    const rad = rader.find((kandidat) => kandidat.noekkel === noekkel)!;
    Object.assign(rad, utfall.ok
      ? { status: "sendt" as const, ...(utfall.forsendelseId ? { forsendelseId: utfall.forsendelseId } : {}) }
      : { status: "feilet" as const, feil: utfall.advarsel.advarsel });
    return rad;
  });
}
