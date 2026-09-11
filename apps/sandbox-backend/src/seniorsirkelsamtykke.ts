/*
 * Samtykket til å bli kontaktet personlig om seniortilbud.
 *
 * **Et annet formål enn dataKilder, med vilje.** hasGyldigSamtykke (regler.ts)
 * avgjør enhver DATA_FETCH ut fra om samtykkets `dataKilder` inneholder
 * datakilden - så et samtykke her med `dataKilder: ["kontaktinfo"]` ville
 * stille tilfredsstilt en helt annen prosess sitt krav om samtykke til å lese
 * kontaktinfo, uten at innbyggeren noensinne ble spurt om *det*. Det er nettopp
 * formålsbegrensning-feilen AGENTS.md advarer mot. Derfor har raden her
 * `dataKilder: []` alltid, og kjennes bare igjen på `formaal`.
 *
 * Ellers samme mønster som CONSENT_REQUEST-håndteringen i prosess.ts: dette er
 * en tynn klient mot de ekte `/fiks/samtykke*`-endepunktene, som allerede
 * skriver gjennom updateJson("samtykker.json", ...) og allerede har
 * tilstandsmaskinen fra apps/shared/samtykke.ts. Ingen ny tilstandsmaskin, ingen
 * ny skriver.
 */
import { maskinportenHeader } from "../../digdir-mock/src/client.ts";
import { fiksBaseUrl, fiksDialogToken } from "./config.ts";
import { effektivStatus } from "../../shared/samtykke.ts";
import { readJson } from "../../shared/jsonstore.ts";
import { callUpstream } from "./upstream.ts";

/** Formålet dette samtykket alltid har. Selve søket etter det, ikke bare en visningstekst. */
export const SENIORSIRKEL_KONTAKT_FORMAAL =
  "Sende deg personlige meldinger om seniortilbud, per SMS eller brev";

export type SeniorsirkelSamtykke = {
  samtykkeId: string;
  personId: string;
  formaal: string;
  dataKilder: string[];
  status: string;
  opprettet: string;
  utloper: string;
};

/**
 * Det gjeldende samtykket for dette formålet, med utløp lagt på - eller `null`
 * når hun aldri har blitt spurt.
 *
 * Leser state/samtykker.json direkte, samme forenkling regler.ts har for
 * hasGyldigSamtykke: dette er en sandkasse, og et eget lite lag foran én fil
 * ville ikke vist noe mer enn filen selv gjør.
 */
export async function finnGjeldendeSeniorsirkelSamtykke(
  personId: string
): Promise<SeniorsirkelSamtykke | null> {
  const samtykker = (await readJson("samtykker.json", [])) as SeniorsirkelSamtykke[];
  const relevante = samtykker.filter((rad) =>
    rad.personId === personId && rad.formaal === SENIORSIRKEL_KONTAKT_FORMAAL);
  if (relevante.length === 0) return null;
  const nyeste = relevante.slice().sort((a, b) => b.opprettet.localeCompare(a.opprettet))[0]!;
  return { ...nyeste, status: effektivStatus(nyeste) };
}

export async function opprettSeniorsirkelSamtykke(
  personId: string,
  sporingsId: string
): Promise<SeniorsirkelSamtykke> {
  return callUpstream<SeniorsirkelSamtykke>(
    { service: "Fiks-simulatoren", action: "Å opprette samtykket", relayStatus: true },
    async () => fetch(`${fiksBaseUrl}/fiks/samtykke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await maskinportenHeader(fiksDialogToken)) },
      body: JSON.stringify({
        personId,
        formaal: SENIORSIRKEL_KONTAKT_FORMAAL,
        dataKilder: [],
        sporingsId
      })
    })
  ) as Promise<SeniorsirkelSamtykke>;
}

export async function svarSeniorsirkelSamtykke(
  samtykkeId: string,
  status: "SAMTYKKET" | "IKKE_SAMTYKKET",
  sporingsId: string,
  aktor: Record<string, unknown>
): Promise<SeniorsirkelSamtykke> {
  return callUpstream<SeniorsirkelSamtykke>(
    { service: "Fiks-simulatoren", action: "Å svare på samtykket", relayStatus: true },
    async () => fetch(`${fiksBaseUrl}/fiks/samtykke/${samtykkeId}/svar`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await maskinportenHeader(fiksDialogToken)) },
      body: JSON.stringify({ status, sporingsId, aktor })
    })
  ) as Promise<SeniorsirkelSamtykke>;
}

export async function trekkSeniorsirkelSamtykke(
  samtykkeId: string,
  sporingsId: string,
  aktor: Record<string, unknown>
): Promise<SeniorsirkelSamtykke> {
  return callUpstream<SeniorsirkelSamtykke>(
    { service: "Fiks-simulatoren", action: "Å trekke tilbake samtykket", relayStatus: true },
    async () => fetch(`${fiksBaseUrl}/fiks/samtykke/${samtykkeId}/trekk`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await maskinportenHeader(fiksDialogToken)) },
      body: JSON.stringify({ sporingsId, aktor })
    })
  ) as Promise<SeniorsirkelSamtykke>;
}
