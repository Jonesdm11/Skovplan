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
- **Prøveflade**: radius (5,64/7,98/10/12,62/15 m), træ-tabel med D1/D2 (krydsklupning), højde og bemærkning. Beregner stamtal/ha, G/ha, Dg (d³/d²) og Hg (grundfladevægtet).
- **Direkte taksation**, **fotos** (1600 px) og **noter** med GPS-punkt og litra.
- Eksporten indeholder `taksationsark_felt_<dato>.csv`, `enkelttraeer_<dato>.csv`, `registreringer.geojson` og `fotos/`.

## Hosting
GitHub Pages fra `main`. Alle biblioteker ligger i `lib/`, så intet hentes udefra ud over OpenStreetMap-fliser.
