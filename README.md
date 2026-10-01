# Texas Weather Explorer

**Live at [farmwth.com](https://farmwth.com)**

Weather apps tell you about the next few days. I built Texas Weather Explorer for growers who want
the longer picture: how this season compares with the last 30 years at their own field, which
past years looked like this one, and what happened in those years.

## What you can do

- **Find your field.** Search for a town, type coordinates, use your phone's location, or click
  the map.
- **Season so far.** Rainfall, growing degree days and hot days since planting, compared with the
  same dates in earlier years. You choose the crop, the dates and the hot-day threshold.
- **Season tracker.** This year's running total of rainfall, growing degree days, temperature or
  water use, drawn against the range of normal years, with any past year laid over it.
- **Similar years.** The past seasons whose weather tracked closest to this one, what the weather
  did next in each, and the county crop yield from those years (USDA NASS).
- **Forecast for the next month.** The National Weather Service forecast for days 1 to 7, a model
  blend for days 8 to 16, and NOAA Climate Prediction Center outlooks out to week 4.
- **Year by year.** Annual totals and averages for up to 30 years, with the long-term change and a
  plain statement of whether that change stands out from the year-to-year swings.
- **Crop water use.** Satellite-based water use for the field (OpenET), the water a reference crop
  would need, and the balance between rainfall and use.
- **Downloads.** Every chart as a CSV file or as a high-resolution figure sized for a report or a
  journal page. Each download records the data source and the exact grid cell it came from.

## Choose your data source

The source picker at the top of the page switches every number on the site between two gridded
datasets:

| Source | Grid size | Record used |
|---|---|---|
| **gridMET** (default), University of Idaho | 4 km | 1996 to present |
| **NASA POWER**, NASA Langley Research Center | about 55 km | 1996 to present |

They do not always agree, and the difference can matter for a decision, so the choice is shown
rather than hidden. Gridded datasets run a few days behind; the most recent days are filled from
the nearest airport weather station and labelled as such.

## Data sources

The site retrieves its data from these providers and does not own any of it. Each keeps its own
terms of use, and full citations are in the **Data sources and citations** section at the foot of
the website.

- gridMET, University of Idaho
- NASA POWER, NASA Langley Research Center
- OpenET, through Google Earth Engine
- Iowa Environmental Mesonet (airport weather stations)
- NOAA National Weather Service and Climate Prediction Center
- Open-Meteo (CC BY 4.0)
- USDA National Agricultural Statistics Service, Quick Stats
- U.S. Census Bureau (county boundaries)
- OpenStreetMap contributors (map and place search)

Landscape photographs on the site are public domain, from the U.S. Department of Agriculture and
Wikimedia Commons.

## How to cite

Use the **Cite this repository** button on the GitHub page, which reads [CITATION.cff](CITATION.cff).

## License

The code is released under the [MIT License](LICENSE). The license does not cover the data from
the providers listed above, or the images in `public/img`.

## Feedback

Questions and suggestions are welcome: [pulkit.juneja@tamu.edu](mailto:pulkit.juneja@tamu.edu)
