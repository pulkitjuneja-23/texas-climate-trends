# Start here — plain language guide

This file is for **you**, not for the computer. No jargon.
(The other file, `CLAUDE.md`, is technical notes for the AI — you can ignore it.)

---

## How to open the website

1. Open the **Terminal** (or PowerShell) app.
2. Get into the project folder by typing this and pressing Enter:

   ```
   cd c:\Claude_Modeling\Weather_Project
   ```

3. Start the preview by typing this and pressing Enter:

   ```
   npm run dev
   ```

4. Wait until it says something like `Ready`, then open your browser to:

   **http://localhost:3000**

That's it. That is the only command you need.

### To stop it
Click on the terminal window and press **Ctrl + C**.

### If the page is blank or looks broken
1. Press **Ctrl + C** in the terminal to stop it.
2. Type `npm run dev` again and press Enter.
3. In the browser press **Ctrl + Shift + R** (a "hard refresh").

That fixes almost everything.

---

## What the computer words mean

| Word | What it really means |
|---|---|
| **dev** / **dev server** | The *preview* of the website, running only on your computer. Nobody else can see it. |
| **npm run dev** | "Start the preview." |
| **localhost:3000** | The address of that preview on your own machine. Like an office extension, not a public phone number. |
| **npm run build** | "Package up the finished version for the real internet." **You don't need this yet.** |
| **typecheck** | A spell-checker for the code. Green means nothing is obviously broken. |
| **terminal** / **PowerShell** | The black window where you type commands. |
| **Ctrl + C** | Stop whatever is running in the terminal. |

**One rule:** never run `npm run build` while the preview is running. They fight over the same
folder and the page goes blank. If you only ever use `npm run dev`, you will never hit this.

---

## What's on the page, top to bottom

**1. Your location**
Four ways to set it:
- **Address / town** — type it and press Search (or Enter).
- **Coordinates** — paste `31.549, -97.147`, or degrees/minutes/seconds.
- **Use my location** — your browser will ask permission, same as any phone app.
- **Click the map** anywhere.

The dashed orange box is the patch of ground your numbers actually come from. With gridMET it's
only 4 km across, so you have to zoom in to see it.

**2. Weather data source** — now at the **top of the page**
The dropdown sits in the bar at the top next to °F/°C and Light/Dark, so you can change it from
anywhere on the page without scrolling back up. **gridMET (4 km)** is the default. You can switch to:

| Source | Grid size | How current | Good for |
|---|---|---|---|
| **gridMET** | 4 km | 3 days behind | Default. Good balance of detail and currency |
| **Daymet** | 1 km | 8 months behind | Finest detail; studying past years only |
| **Airport stations** | a single point | current | Real instrument readings, not a model |
| **NASA POWER** | 55 km | 5 days behind | Very coarse; whole-region trends |

**If a box says "incomplete — only 173 of 194 days reported"**, the weather station skipped days,
so the total underneath it is missing whatever fell on the days it missed. The page shows the total
(it is genuinely what the station recorded) but **deliberately hides the "vs normal" comparison**,
because comparing a part-year against a full-year average invents a drought that isn't there.

This matters most for rainfall. Rain arrives on a handful of days, so a station missing a quarter of
the year can easily miss most of the rain — one Texas station showed 1.8 inches when the true figure
was nearer 8. Temperature suffers far less, because one missing day barely shifts an average.

If you see it, switch to **gridMET** or **Daymet**, which have no missing days.

**A warning about Airport stations.** It is the only real rain gauge here, which makes it valuable —
but a station can go down for weeks or months. When that happens the year-by-year chart will leave
those years out and **tell you which ones**, e.g. *"4 years not shown (2019, 2020, 2024, 2025) — the
weather station missed too many days."* That is not a fault in the tool; it is the station's record
being incomplete, and adding up a half-reported year would show a drought that never happened.
Switch to gridMET or Daymet to fill those gaps. Stations near big airports (Waco, Lubbock, Amarillo)
are usually complete; remote parts of west Texas are patchier.

**Why PRISM isn't listed:** PRISM only publishes maps of the whole United States, one day at a time.
Getting 30 years for your field alone would mean about 43,000 downloads. gridMET is the practical
substitute — same 4 km detail, and it's *built from* PRISM.

**Why Open-Meteo isn't listed:** still used behind the scenes for the days 8–16 forecast, but
removed as a history option — at Texas locations it reads consistently wettest and badly missed the
2022 drought.

**These sources genuinely disagree.** For Waco, 1 January to 19 August 2026, rainfall so far:

- gridMET: **25.0 in**
- Open-Meteo: **21.1 in**
- Airport gauge 11 km away: **19.8 in**
- NASA POWER: **19.3 in**

Nearly six inches apart, for the same field, over the same months. That is not a bug — it is the
reason this tool lets you pick. If a number matters for a decision, check it against the airport
station, which is the only one that is an actual rain gauge rather than a computer model.

**3. Season so far**
Rain, growing degree days, estimated water used (ET) and the deficit, each against normal.
**Each box has a date underneath that you can change** — it defaults to 1 January, but set it to
your planting date to see accumulation since planting instead.

Two things to read carefully here:

- It says **"Estimated ET"**, not "ET", on purpose. The satellite gives one figure per month; the
  box divides that across the month's days so it can line up with whatever start date you pick.
  Right to the month, interpolated within it.
- If a box shows a date range in red, like **"Jan 1 – Apr 5 only"**, that box covers a *shorter
  period* than the rain box beside it. It happens when cloud stopped the satellite measuring some
  months. Don't subtract one box from another in your head when you see it — the deficit box
  already does the comparison correctly, over the matching dates.

**4. Season tracker** — the big chart
One year, January to December, left to right.
- The **grey bands** are what the last 30 years did. Darker inner band = the middle half of years.
  Lighter outer band = the middle 80%.
- The **dashed grey line** is the average.
- The **blue line** is this year.

If the blue line is below the grey band, you're drier than almost any year in the record.
You can add up to 4 past years on top using the year buttons.

**Download.** Both charts have a **CSV** and a **Figure** button at the end of their controls.

- **CSV** gives you the numbers behind the chart exactly as it is set right now — same variable,
  same units, same years, same view. Opens in Excel. The first few lines start with `#` and record
  where the data came from; Excel shows them as ordinary rows and R or Python skip them
  automatically.
- **Figure** saves a high-resolution image for a report or a slide, about three times screen
  resolution so it stays sharp when printed.

Both carry the **source and the exact grid cell** they came from, printed on the image and at the
top of the spreadsheet. That is deliberate. The sources disagree by up to 30% on rainfall, so a
number that leaves this page without saying which dataset produced it is a number nobody can check
later — including you, in six months. The trend figure also carries the "read the bars, not the
line" warning when the trend is weak, so the caveat travels with the picture.

**4b. Water — three new options in the Variable dropdown**

- **Water demand (reference ET)** — works now, no setup. How much water a standard crop would have
  needed. Covers all 30 years, only 3 days behind.
- **Water used (ET)** — what the field *actually* used, measured from satellite at 30 m. Only goes
  back to **late 2015**, so on the chart its line simply starts partway across — the earlier years
  are blank, not zero.

  > **Put the pin on the actual field.** Water use is far more sensitive to exactly where you click
  > than rainfall is. For 2024 near Waco: a pin in the middle of town reads **14 inches** a year,
  > a pin on cropland twenty miles away reads **36 inches**. Both are correct — pavement really
  > doesn't transpire. But it means the town shortcuts are useless for this variable, and so is the
  > default starting location. Zoom in and click your field.

  > **Some months are simply missing.** When it's too cloudy for the satellites, the models can't
  > produce a value for that month — it happened in April and May of 2021 and 2026. When that
  > occurs the season line **stops there** and the page tells you which months are missing. It stops
  > on purpose: pretending no water was used during the gap would make a dry season look
  > comfortable, which is the wrong way to be wrong.
- **Water balance (rain − ET)** — rain minus water used. This is the one that answers "do I need to
  water?"

  It is always rain minus water used, everywhere on the page, and it is always described in words
  so you never have to work out what a minus sign means:

  | You see | It means |
  |---|---|
  | **2.1 in surplus** (blue) | More rain fell than the crop used. No shortfall. |
  | **1.6 in short** (red) | The crop used 1.6 in more than it rained. That came out of soil moisture, or has to be irrigated. |

  On the bar chart the same thing is shown by direction: bars above the zero line are a surplus,
  bars below it are short.

  The word "deficit" is deliberately not used anywhere — "deficit −1.6" could be read two opposite
  ways, which is exactly the confusion this replaced.

Worth noticing on the demand chart: the grey band is *narrow*. Water demand barely changes from year
to year, while rainfall swings wildly. The demand side is predictable; the supply side is not.

**Two honest limits on the balance number.** First, it inherits whichever rainfall source you picked
— and those disagree by up to 30%, which at Waco is the difference between a small surplus and a
4.7 inch deficit. Second, it is only rain minus water used. It does not account for runoff, water
draining below the roots, moisture already in the soil, or irrigation you already applied. Treat it
as a warning light, not an irrigation prescription.

**5. "Which year is this one tracking like?"**
Looks at your last 150 days and finds the past years that started out the same way — then shows
**what happened next** in each of those years.

That last column is the useful part. If those years all went the same way afterwards, that means
something. If they scattered wildly, that means something too — and the box says so in plain words
at the top. It is **not** a forecast.

**The crop column, at the far right.** The heading itself is a dropdown — pick your crop and the
column shows what that crop actually yielded, in your county, in each of those matched years. Only
crops your county actually grows are listed, so the choices change as you move the pin.

The column shows the plain yield, so you can compare the years by eye. **Hover over a number — or
tap it on a phone — and it also tells you how that year compared to the long-term trend:**

> **395** &nbsp;→ hover → &nbsp; **−44%**

You need that second figure more than it looks. Yields have been climbing for thirty years for
reasons that have nothing to do with weather: better seed, better equipment, better practice. Texas
cotton has improved about **1.6% a year, every year**. So a perfectly good season in 1998 produces a
smaller number than a mediocre one in 2023, purely because of the seed available at the time.

Comparing each year against the trend **for that year** removes that. **Plus means the harvest beat
what was normal for its era; minus means it fell short.** Blue is above, red is below. Tap again to
hide it.

Three more things about this column:

- **It follows the °F/°C switch at the top**, like everything else. In metric it shows **t/ha**
  (tonnes per hectare). Each crop converts differently — a bushel is a measure of *volume*, and a
  bushel of oats weighs 32 lb where a bushel of wheat weighs 60 — so the sums are done per crop.
- **Where there is a "Yield from" switch**, you can choose irrigated acres, dryland acres, or both
  together. Take dryland if you have it — those are the acres the weather actually decides, and it
  is the honest comparison against a dry year. Only about half the crops publish the split.
- **This is a whole-county average**, which is much coarser than everything to its left. The rain
  and temperature columns come from the 4 km square containing your pin; the yield is every farm in
  the county, on every soil, planted on every date. Read it as "how did this crop go around here
  that year", not as a prediction for your field.
- A **dotted underline** under the percentage means your county reports too few years to work out
  its own trend, so the statewide rate was used instead, set to your county's own average level.

The current year says **"not yet"** — the figures are published the spring after harvest. The
**30-year Normal** row shows what a normal year yields *now*, rather than an average of the years
above, which would be dragged down by thirty years of older seed.

**If the column is mostly dashes, that is usually real.** USDA only publishes a county figure where
enough farms grow the crop, and much of Texas simply doesn't. Sixteen counties have exactly one
crop and thirty-one have none at all — the Hill Country south-west of Austin is ranch land, so
Bandera County has one single year of wheat in thirty. When that happens the page now tells you so
underneath the table, in words, and the dropdown opens on whichever crop has the longest record for
your county rather than the most important one statewide. If it still looks thin, try the other
crops in the list.

**"none" means the crop failed.** USDA sometimes publishes a yield of zero — a crop planted but
never harvested, usually in a drought year. Those years are shown as "none" rather than "0", and
they are deliberately left out of the long-term trend: a failed crop is the *absence* of a yield,
not a low one, and counting it would drag the "normal" down and make every other year look better
than it was.

**6. Next month prediction** — the forecast
Three levels, deliberately kept apart because they are not equally trustworthy:
- **Days 1–7** from the National Weather Service. Trust this.
- **Days 8–16** from a weather model blend. A direction, not a number to plan a spray around.
- **Weeks 2–4** from NOAA's Climate Prediction Center. These are *odds*, not amounts —
  "70% chance of above normal" means the odds are tilted warm, not that it will be any specific
  temperature.

**7. Year-by-year trend**
One bar per year. Blue = wetter than average, red = drier. The dashed line is the trend. Change per
decade and the long-term average sit at the top right.

When the trend line isn't worth trusting, the text under the title says so in plain words —
"the swing between years is far bigger than the long-term drift, so read the bars, not the line."
Take that seriously. For Waco rainfall, gridMET says the trend is **going up** 2.17 in per decade
while NASA POWER says it's **going down** 1.25 in per decade. Same field, opposite answer. Even
over 30 years the year-to-year noise can swamp any real drift.

---

## Honest limits

- **Even the best grid here is 1–4 km, and the sources disagree by up to 30% on rainfall.** Treat
  any single number as an estimate. The airport station is the only real measurement, but it is one
  point — a station 30 miles away easily misses a thunderstorm that hit your field.
- **The "normal" here is 1996–2025 from a computer model**, not the official National Weather
  Service station normals. That is thirty complete years, the usual length for a normal, but the
  Weather Service uses 1991–2020 — so it won't match a NWS climate report exactly.
- **Similar years are not a forecast.** They are history, shown as a range.
- **Nothing here has been checked against a real rain gauge on a real farm.** It should not be the
  only thing behind an irrigation or planting decision.

---

## Questions I still need from you

1. Which crops and planting windows matter most for the Texas version?
2. Can the farmer who gave you the original feedback try the "Which year is this one tracking like?"
   box? It's the most original part and the least tested against how a grower actually thinks.
3. Does any wording on the page read like jargon? Say so and it gets changed — the whole point is
   that a farmer can use it without a manual.
