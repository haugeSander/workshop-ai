/*
 * Varsler: den korte beskjeden, ikke dokumentet.
 *
 * Dette er ikke SvarUt, og det er hele grunnen til at filen finnes ved siden av
 * forsendelse.ts. De to gjør forskjellige ting, og kanalvalget skiller seg på det
 * ene punktet som betyr noe:
 *
 *   forsendelse  et dokument - vedtaket, kvitteringen. Faller til PRINT, fordi et
 *                brev er et brev, og det er greit at det kommer om tre dager.
 *   varsel       «husk turen på tirsdag», «kurset er avlyst». Faller *ikke* til
 *                papir. En påminnelse i posten kommer etter turen, og et varsel
 *                ingen kan lese i tide er verre enn ikke noe varsel: det ser
 *                sendt ut i loggen.
 *
 * Derfor kjenner `chooseKanal` bare DIGITAL og PRINT, og denne bare SMS, EPOST og
 * INGEN. Å legge SMS inn i den andre ville slått de to sammen, og da hadde
 * spørsmålet «hvem fikk vedtaket» og «hvem ble minnet på» hatt samme svar.
 *
 * Modulen er ren og kjenner ingen HTTP: `pnpm test:varsel` kjører den uten port.
 */

import type { Krr } from "../../shared/innbyggerdata.ts";
// Kodeverkene bor i apps/shared fordi sandbox-backend leser dem også. Avgjørelsen
// under blir igjen her: kanalen leses av kontaktregisteret, og det er Fiks-siden.
import { SMS_MAKSLENGDE, VARSELTYPER } from "../../shared/varsel.ts";
import type { Varselgrunn, Varselkanal } from "../../shared/varsel.ts";
export { SMS_MAKSLENGDE, VARSELGRUNNER, VARSELKANALER, VARSELTYPER } from "../../shared/varsel.ts";
export type { Varselgrunn, Varselkanal, Varseltype } from "../../shared/varsel.ts";

export type Varselkanalutfall = {
  kanal: Varselkanal;
  /** Bare naar kanalen er INGEN. Da er den paakrevd - se VARSELGRUNNER. */
  grunn?: Varselgrunn;
};

/**
 * Kanalen et varsel går på, ut fra kontakt- og reservasjonsregisteret.
 *
 * **Reservasjonen stenger.** Den gjelder digital kommunikasjon fra det offentlige,
 * og et varsel er nettopp det. At innbyggeren ellers ville fått brev hjelper ikke
 * her: det finnes ingen papirkanal for et varsel. Følgen er at en reservert
 * innbygger ikke får påminnelser i det hele tatt, og det er et svar påmeldingen må
 * kunne gi henne på forhånd framfor at det oppdages ved at ingenting skjer.
 *
 * **SMS foran e-post.** Et varsel er tidskritisk og kort. Er begge oppgitt, vinner
 * telefonen; e-post er reserven, ikke førstevalget.
 */
export function velgVarselkanal(
  krrRad: Pick<Krr, "kanVarsles" | "reservert" | "tlf" | "epost"> | undefined
): Varselkanalutfall {
  if (!krrRad) return { kanal: "INGEN", grunn: "ukjent_i_kontaktregisteret" };
  if (krrRad.reservert) return { kanal: "INGEN", grunn: "reservert" };
  if (!krrRad.kanVarsles) return { kanal: "INGEN", grunn: "kan_ikke_varsles" };
  if (krrRad.tlf?.nummer) return { kanal: "SMS" };
  if (krrRad.epost?.adresse) return { kanal: "EPOST" };
  // kanVarsles uten en eneste kontaktopplysning er en selvmotsigelse i registeret,
  // ikke en tilstand vi kan handle paa. Den faar sin egen grunn framfor aa bli
  // stilltiende slaatt sammen med «kan ikke varsles».
  return { kanal: "INGEN", grunn: "ingen_kontaktopplysning" };
}

export type Varselkropp = {
  type?: string;
  digitalId?: string;
  tekst?: string;
  /** Kallerens egen noekkel, saa den kan kjenne igjen raden sin. */
  eksternReferanse?: string;
};

export type Varselfeil = { melding: string; kode: string };

/**
 * Kroppen, før kanalen er valgt.
 *
 * Lengden sjekkes ikke her, men i `validateVarsellengde` etter kanalvalget: en
 * tekst på 200 tegn er feil for en SMS og helt i orden for en e-post, og hvilken
 * det blir vet vi først når registeret er lest.
 */
export function validateVarsel(kropp: Varselkropp): Varselfeil | null {
  if (!kropp?.digitalId) {
    return { melding: "digitalId er påkrevd.", kode: "MANGLER_MOTTAKER" };
  }
  if (!kropp.tekst?.trim()) {
    return { melding: "tekst er påkrevd.", kode: "MANGLER_TEKST" };
  }
  if (!(VARSELTYPER as readonly string[]).includes(String(kropp.type))) {
    return {
      melding: `Ukjent varseltype ${kropp.type}. Gyldige: ${VARSELTYPER.join(", ")}.`,
      kode: "UKJENT_VARSELTYPE"
    };
  }
  return null;
}

/**
 * Teksten mot kanalen den faktisk skal gå på.
 *
 * Grensen håndheves her, på sendeflaten, og ikke i prompten som skrev teksten. En
 * regel modellen blir bedt om å følge er en regel som holder mesteparten av tiden;
 * dette er stedet den kan holdes hver gang. Samme begrunnelse som at vilkårene
 * ligger i kode og ikke i en systemmelding.
 */
export function validateVarsellengde(tekst: string, kanal: Varselkanal): Varselfeil | null {
  if (kanal !== "SMS" || tekst.length <= SMS_MAKSLENGDE) return null;
  return {
    melding: `Teksten er ${tekst.length} tegn, og en SMS tar ${SMS_MAKSLENGDE}. `
      + "Kort ned teksten, eller send den til en mottaker som har e-post.",
    kode: "FOR_LANG_SMS"
  };
}
