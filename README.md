# SkovPlan Felt

En lille webapp, der installeres fra browseren ("Føj til startskærm") og virker uden net bagefter. Ingen app store.

## Det kan den
- Åbne skovens GeoPackage direkte på telefonen (fx `skovdriftsplan.gpkg` fra Google Drev). Viser litraer farvet efter træart, veje, kortlinjer og ejendomsgrænse.
- Vise din GPS-position og hvilket litra du står i.
- Tryk på et litra: se art, alder, Hg, Dg, stamtal, G, vedmasse og bemærkning.
- **Prøveflade**: radius (5,64/7,98/10/12,62/15 m), diametre (+ evt. højder) træ for træ. Beregner stamtal/ha, G/ha, Dg (d³/d²) og Hg (grundfladevægtet af målte højder).
- **Direkte taksation** af et litra (Hg, Dg, stamtal, G, vedmasse, Bk, ny træart).
- **Fotos** (kamera, formindskes til 1600 px) og **noter**, med GPS-punkt og litra.
- **Eksportér til SkovPlan**: en zip med
  - `taksationsark_felt_<dato>.csv` – samme kolonner som SkovPlans taksationsark; indlæses med «Importér bevoksningsliste fra Excel/CSV…» (afprøvet mod `taksationsark.parse_sheet`).
  - `registreringer.geojson` – alle punkter med data (kan trækkes ind i QGIS).
  - `fotos/`.
  Deles via telefonens del-menu (Drev, mail …).

## Begrænsninger i prototypen
- Baggrundskortet er OpenStreetMap og gemmes kun for de fliser, man har set med net. Ortofoto fra Dataforsyningen kræver en gratis token (næste skridt).
- Vedmasse beregnes ikke af prøvefladerne (feltet efterlades tomt = SkovPlan beholder sit tal).
- Fotos og noter kommer ikke automatisk ind i SkovPlans gpkg endnu; de ligger i geojson + fotos-mappen.

## Hosting
Appen skal ligge på en https-adresse (krav for GPS, kamera og offline). Mappen her kan lægges som den er på GitHub Pages eller Netlify. Alle biblioteker ligger i `lib/`, så intet hentes udefra ud over kortfliser.

Adresse: https://jonesdm11.github.io/Skovplan/
