# SkovPlan Felt

En lille webapp, der installeres fra browseren ("Føj til startskærm") og virker uden net bagefter. Ingen app store.

Adresse: https://skovplan.github.io/Skovplan/

## Sådan bruges den
1. **I SkovPlan:** Import og ældre driftsplaner › **Lav feltpakke til appen…** Det laver `Eksporter/Feltapp/Feltpakke_<ejendom>.zip` med skovkort og ortofoto.
2. **På telefonen:** åbn appen, tryk **Åbn feltpakke** og vælg filen i Drev. Kort og ortofoto gemmes på telefonen og virker uden net.
3. **I skoven:** prøveflader (krydsklupning, træ for træ), direkte taksation, fotos og noter.
4. **Eksportér til SkovPlan (Drev):** gem zip-filen i Drev-mappen **SkovPlan Felt**.
5. **I SkovPlan:** **Hent data fra app…** finder selv den nyeste eksport til ejendommen og indlæser litra-tal, prøveflader, fotos og noter.

### Online-synkronisering (Supabase)
Er synk sat op i SkovPlan («Opsæt online-synk med SkovPlan Felt…»), har feltpakken en ejendomsnøgle, og appen sender selv
registreringer og fotos, når telefonen har net («Send til SkovPlan nu» i menuen tvinger det). SkovPlan henter dem, når ejendommen åbnes.
Databasen oprettes med `skovplan_felt_opsaetning.sql` (ligger i projektfilerne under feltapp/supabase).

Appen kan også åbne `skovdriftsplan.gpkg` og `ortofoto_feltapp.mbtiles` hver for sig. Filtypen afgøres af indholdet, ikke navnet.

## Det kan den
- Litraer farvet som i SkovPlan, veje, kortlinjer og ejendomsgrænse oven på ortofotoet.
- GPS-position og hvilket litra du står i; tryk på et litra for art, alder, Hg, Dg, stamtal, G, vedmasse og bemærkning.
- **Prøveflade**: vandret radius (5,64/7,98/10/12,62/15 m), træ-tabel med D1/D2 (krydsklupning i 1,3 m), højde og bemærkning, valgfri klupningsgrænse. Et kanttræ tæller, når stammens midte er inden for radius. Beregner stamtal/ha, G/ha, Dg (kvadratisk middeldiameter, som i SkovPlan; den grundfladevægtede Σd³/Σd² vises ved siden af) og Hg.
- **Litraets Hg** er Loreys middelhøjde (Σg·h/Σg) over alle træer. Har litraet mindst 3 målte højder, aflæses de øvrige træers højde på en Näslund-højdekurve h = 1,3 + (d/(a+b·d))², tilpasset pr. art (ellers pr. litra).
- **Relaskopmåling**: G = BAF × (ind + ½ grænse). Stamtal, Dg og Hg regnes pr. art ud fra de målte træer af samme art (w = talte/målte pr. art); arter uden målte træer får kun G. Tallene kommer først i taksationsarket, når litraet har mindst 8 målte træer af arten (ellers «skøn»): mål 1–2 træer på hvert punkt, så litraet får mindst 10. Faktoren låses kun til punkter fra samme år. Kamerasigtet er en hjælp, ikke et kalibreret relaskop (ingen hældningskorrektion).
- **Vedmasse** = G × Hg × formtal pr. art = skaftmasse m. bark til top, uden grene (SkovPlans stammekurve; formtal 0,30–0,70). For bøg, eg og ask vises Madsens DFF 350-volumen med grene til sammenligning. Er Hg taget fra planen, eksporteres vedmassen ikke.
- **Taksationsarket** fra appen indeholder litraets hovedart (største grundflade); de andre arter vises i appen.
- **Stakke og stokke**: rummeter = L × D × H (flere mål med mellemrum giver gennemsnit; «+» og «/» afvises), m³ fast = rm × fastmasse-% (beregnet), rm flis (løs) = m³ fast × 2,6 som i SkovPlan. Stokke efter Huber, målt med eller uden bark (barkfradrag pr. art som forslag), nedrunding af d til hel cm og L til 0,1 m og overmål.
- **Rettelser og sletninger** sendes med i næste eksport/synk; SkovPlan opdaterer rettede registreringer og markerer slettede (staklisten viser «opmålt/rettet <dato>» og udelader slettede).
- **Direkte taksation**, **fotos** (1600 px) og **noter** med GPS-punkt og litra. En note kan have flere billeder.
- **Generel note** (menuen): note med billeder, der ikke hører til et litra, fx om veje eller hegn.
- I SkovPlan står litraets noter og fotos i sin egen sektion **«Fra felten»** i litra-vinduet, ikke i bemærkningen.
- Eksporten indeholder `taksationsark_felt_<dato>.csv`, `enkelttraeer_<dato>.csv`, `registreringer.geojson` og `fotos/`.

## Hosting
GitHub Pages fra `main`. Alle biblioteker ligger i `lib/`, så intet hentes udefra ud over OpenStreetMap-fliser.
