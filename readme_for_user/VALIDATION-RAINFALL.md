# How our rainfall compares with the state's own map

**28 August 2026.** Someone reported that the numbers looked off, so this is a
check of our year-to-date rainfall against an independent source: the
**TexMesoNet "Year to Date Precipitation" map**, which is NOAA/NWS Office of
Dissemination gridded precipitation published through the Texas Water
Development Board.

Short answer: **gridMET, our default, agrees with the state map at every one of
32 sites to within one colour band, and lands in the exact band at two thirds of
them.** The one source that was genuinely off is the airport-station option,
which we had already removed from the picker earlier the same day — this check
confirms that was the right call and probably explains the complaints.

---

## What was compared

- **Reference:** the TexMesoNet map, year-to-date through 28 Aug 2026 08:02.
- **Ours:** 1 January to 26 August 2026 (our data ends on the 26th — see the
  caveats).
- **Where:** 32 sites spread across all ten Texas climate divisions, from
  El Paso to Texarkana and Dalhart to Brownsville.

The map is published as colour bands, not numbers, so it was read directly out
of the PDF rather than by eye. The file turns out to be a *geospatial* PDF, which
carries its own map projection and corner coordinates, so every site could be
looked up at its exact latitude and longitude.

**The lookup was checked before any of the numbers were trusted.** The map draws
the Texas outline as lines, and Texas has four borders that are perfectly
straight in reality:

| Border | Should be | Read as | Off by |
|---|---|---|---|
| Panhandle west edge | 103.0417° W | 103.0374° W | 0.4 km |
| Panhandle east edge | 100.0000° W | 100.0114° W | 1.0 km |
| Panhandle north edge | 36.5000° N | 36.4985° N | 0.2 km |
| New Mexico line | 32.0000° N | 32.0009° N | 0.1 km |

About a kilometre — far finer than either dataset's own resolution.

---

## Result 1 — against the state map

| Source | Exact band | Within one band | Bias | Typical error | Correlation |
|---|---|---|---|---|---|
| **gridMET** (our default) | 21 / 32 (66%) | **32 / 32 (100%)** | −0.5 in | 2.1 in | 0.963 |
| NASA POWER | 17 / 32 (53%) | 31 / 32 (97%) | −1.7 in | 2.6 in | 0.958 |
| Airport stations | 10 / 32 (31%) | 21 / 32 (66%) | **−7.2 in** | 7.4 in | 0.341 |

Against a mean of about 20 inches, gridMET's half-inch bias is **2.5%**.

Some of that 2.1 in "typical error" is not error at all: the map only says which
5-inch band a place is in, so even a perfect match would score about 1.5 in
against a band's midpoint. Correcting for that, gridMET's real disagreement with
the map is closer to **2.4 in**, and NASA POWER's to 3.2 in.

---

## Result 2 — everything against real rain gauges

Neither our grid nor the state map is ground truth: both are estimates, and the
state map is radar-based, which has its own well-known problems (hail inflating
totals, and poor coverage in west Texas where radars are far apart). So airport
rain gauges were brought in as a third opinion, at the 20 sites where the gauge
reported at least 95% of days.

| Estimate | Bias vs gauge | Typical error | Correlation |
|---|---|---|---|
| gridMET | +2.0 in | 2.6 in | 0.954 |
| NASA POWER | +1.5 in | 2.9 in | 0.899 |
| **The state's own map** | +2.4 in | 2.7 in | 0.949 |

**All three read high against gauges by about the same amount, including NOAA's
own map.** That is expected rather than alarming: a rain gauge undercatches in
wind by 5–15%, and a gauge measures one point while a grid cell averages several
square miles.

Counting site by site, whichever estimate landed closest to the gauge: **gridMET
7, NASA POWER 7, the state map 6.** A three-way tie — our default is not
measurably worse than the source the state publishes.

---

## What was actually wrong

**The airport-station source.** It ran 7.2 inches low on average and barely
correlated with anything (0.34). The cause is already documented: airport
stations drop days, and a rainfall total that skips days is missing most of its
rain, because rain arrives on a few days. It was removed from the source picker
earlier on 28 Aug 2026 for exactly this reason, and these numbers confirm it.

**A new problem this check found.** Our sparse-data guard counts *days reported*.
Paris, Texas reported 95% of days and still totalled **2.1 inches** where both
the state map and gridMET say about 30. It is not a dry site — it is a gauge
writing 0.00 every day instead of writing nothing, and counting days cannot see
that. Half of the 32 stations checked failed one quality test or another.

This mattered beyond the hidden station source, because the **nearest station
also fills the last few days behind gridMET** — so a dead gauge was adding false
zeros to the most recent rainfall at any location, including the default pin.

**Now fixed.** Before using a station's rainfall, the site compares it against
the gridded source over the four months where both have data. A gauge reading
under a fifth of the grid over that long is not measuring, so its rainfall is
dropped and the last few days simply show no rain figure rather than a wrong
one. Its temperatures are kept — a seized rain gauge does not stop a
thermometer.

The cut-off sits in a real gap, measured across 30 sites:

| Gauge vs grid | Site | |
|---|---|---|
| 0.11 | Paris | dropped |
| 0.19 | Temple — **the default pin** | dropped |
| 0.24 | Muleshoe | kept (its station is 60 km away in New Mexico — a different fault) |
| 0.70 – 1.38 | the other 25 sites | kept |

---

## Caveats worth knowing

- **Our totals stop two days short.** The map is dated 28 August; our data ended
  on the 26th. Any rain in those two days makes us look low, which accounts for
  part of gridMET's −0.5 in bias.
- **The map is banded, not numeric**, so "exact band" is the honest metric and
  anything computed from band midpoints carries built-in slop.
- **Bands are ambiguous on a sharp gradient.** At Uvalde only half the pixels
  around the site were the same colour, so "the band" there is genuinely
  uncertain — and Uvalde is one of the larger disagreements.
- **32 sites, one year, one variable.** This says nothing about temperature,
  about other years, or about locations far from a town.

---

*Reproduce with `scratchpad/verify2.mjs`, `gauge-audit.mjs` and `final2.mjs`
against the published PDF.*
