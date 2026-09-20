/**
 * Default-Prompts. Gemini wertet Bild- und Tonspur gemeinsam aus, deshalb wird
 * explizit nach beidem gefragt -- ohne diese Aufforderung faellt das Modell
 * haeufig auf eine reine Transkript-Zusammenfassung zurueck.
 */

export const DEFAULT_PROMPT = [
  'Analysiere dieses Video vollstaendig und antworte auf Deutsch.',
  '',
  'Struktur der Antwort:',
  '1. **Kurzfassung** - 3 bis 5 Saetze: worum geht es, wer spricht, was ist das Fazit.',
  '2. **Kapitel** - der komplette Ablauf als Liste, jedes Kapitel mit Zeitstempel',
  '   im Format [mm:ss] oder [hh:mm:ss], einer Ueberschrift und 1-3 Saetzen Inhalt.',
  '   Decke das Video von Anfang bis Ende ab, lass keinen groesseren Abschnitt aus.',
  '3. **Wichtigste Aussagen** - konkrete Fakten, Zahlen, Namen, Produkte, Versionen,',
  '   Befehle oder Empfehlungen, jeweils mit Zeitstempel.',
  '4. **Visuell gezeigt** - was im Bild zu sehen ist und nicht gesagt wird:',
  '   Bildschirminhalte, Code, Diagramme, Hardware, Einblendungen, Demos.',
  '5. **Fazit / Einordnung** - Kernbotschaft und fuer wen das Video relevant ist.',
  '',
  'Regeln: Nutze Tonspur UND Bild. Zeitstempel muessen zum tatsaechlichen Video',
  'passen. Erfinde nichts - was unklar bleibt, kennzeichne als unsicher.',
].join('\n');

/**
 * Haengt bei einer Ausschnittsanalyse den Zeitrahmen an den Prompt an.
 * Wichtig fuer den agentic-Modus, der keine Offsets kennt und den Bereich
 * nur ueber den Text erfaehrt.
 */
export function mitZeitrahmen(prompt, vonText, bisText, offsetsAktiv) {
  if (!vonText && !bisText) return prompt;
  const bereich = vonText && bisText
    ? `von ${vonText} bis ${bisText}`
    : vonText ? `ab ${vonText}` : `bis ${bisText}`;
  const hinweis = offsetsAktiv
    ? `Dir wird ausschliesslich der Videoausschnitt ${bereich} vorgelegt. Die Zeitstempel in deiner Antwort beziehen sich auf das Gesamtvideo, der Ausschnitt beginnt bei ${vonText || '0:00'}.`
    : `Beziehe dich ausschliesslich auf den Abschnitt ${bereich} des Videos und ignoriere den Rest.`;
  return `${prompt}\n\n${hinweis}`;
}
