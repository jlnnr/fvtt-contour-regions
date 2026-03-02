# Contour Regions

This module for [FoundryVTT](https://foundryvtt.com/) allows you to paint height/contour maps and convert them to elevated regions.

## Why do I need this module?
Although it is possible to create complex elevated landscapes without this module it is very tedious and time consuming using the built-in region painting tools.
This module offers specialized painting tools that make it easy to create intricate landscapes in a matter of minutes and converts them to regions of their corresponding elevation. Additionally heightmaps can be imported to create terrain from pre-existing heightmaps or real world elevation data.


## How does it work?
Each contour band of the painted heightmap is converted to a region corresponding to the band's elevation using the "plateau" flag from [Terrain Mapper](https://github.com/caewok/fvtt-terrain-mapper). These handle elevation seamlessly and smoothly when a token is moved over the elevated region as long as "constrained movement" is enabled in the scene settings.


## Features
## Drawing Tools
**Paint Brush:** Either paint a fixed elevation or raise/lower elevation. The steepness setting determines by how many bands elevation is raised/lowered.

**Flood Fill:** Fills enclosed space with a single elevation.

**Erase Elevation:** Sets painted over elevation to 0.

**Flatten Elevation:** Raises/lowers painted over elevation to the highest/lowest elevation inside the brush area at the start of the drag.

**Gradient Tool:** Applies a Laplacian blur to the selected area to smooth out elevation. The strength determines the amount of blur from "rounded" edges to complete interpolation between the selected. Useful to create slopes from hard edges or smooth out the shape of terrain.

**Line Tool:** Creates a gradient along a line following the defined points. Elevation can either be set manually for every created points or to automatically interpolates between the existing elevation at all points along the line or just at the beginning and end of the line. This allows for easy generation of sloping paths.

**Lock:** Stops all existing elevation from being painted over while active, excluding the erase tool.

**Clear:** Clears the entire heightmap.


## Settings
**Canvas:** The background scene elevation, elevation increment per band, number of contour bands up to 100 and cell resolution (min. 5 px) can be chosen by the user. The larger the cell resolution the smoother painting becomes on low-end PCs. For importing heightmaps based on real world elevation a small cell resolution should be chosen as otherwise a very large amount of regions could be created.
Additionally includes options to choose the unit and adjust the color palette (the current options are standard terrain, heatmap, greyscale and vivid color palette), including a toggle to switch to a color palette repeating every 10 bands when working with many bands.
**Region Conversion:** Option to smooth out edges between bands and ignore small bands which is useful when isolated elevation dots are accidentally created during drawing or when import heightmaps.

## Importing and exporting of heightmaps
### Import
Heightmaps based on 8/16 bit greyscale where the color value corresponds to elevation can be imported and converted to a heightmap in the canvas. The base elevation, elevation increment per band and number of bands can be chosen. The more bands are chosen, the finer the elevation is sampled, however this can lead to very small bands. The image can be move, resized and rotate when previewed on the canvas before the final import.

There are many possible sources for greyscale heightmaps. They can be generated from real world elevation data using GIS software or using web tools (I like [this one](https://manticorp.github.io/unrealheightmap/)). They can also be generated from landscapes built in blender or of course from any other kind of greyscale image – you can really get creative here.

### Export
Exports the heightmap as an 8 bit greyscale image which each cell corresponding to a pixel. They can be imported again to reuse the original heightmap in another scene.

## Required Modules
- [Terrain Mapper](https://github.com/caewok/fvtt-terrain-mapper)
  - [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper)
  - [socketlib](https://github.com/farling42/foundryvtt-socketlib)
 
## Recommended Modules
- [Tagger](https://github.com/fantasycalendar/FoundryVTT-Tagger)
- [Wall Height](https://github.com/theripper93/wall-height)

Many thanks to caewok for creating [Terrain Mapper](https://github.com/caewok/fvtt-terrain-mapper), this module really just extends the functionality which he has built.

Disclaimer: this tool was almost entirely built using Claude Code. I'm not an expert on javascript or the Foundry API since this is my first module and at the moment I possess neither the time nor skill to code a module like this by hand. It still took me a lot of time to figure out the tools and iron out errors. However, this module would not exist without it and allowed me to make this idea, which I have had for some time, into reality.
