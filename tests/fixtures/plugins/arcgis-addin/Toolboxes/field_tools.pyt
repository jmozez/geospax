# -*- coding: utf-8 -*-
"""A small ArcGIS Python toolbox, kept as a fixture: GeoSpaX reads its tool list."""
import arcpy


class Toolbox(object):
    def __init__(self):
        self.label = "Field Tools"
        self.alias = "fieldtools"
        self.tools = [PhotoPoints]


class PhotoPoints(object):
    def __init__(self):
        self.label = "Photo points"
        self.description = "Extract geotagged photo locations into a feature class."
        self.canRunInBackground = False

    def getParameterInfo(self):
        params = [
            arcpy.Parameter(displayName="Photo folder", name="folder", datatype="DEFolder",
                            parameterType="Required", direction="Input"),
            arcpy.Parameter(displayName="Output points", name="out_points", datatype="DEFeatureClass",
                            parameterType="Required", direction="Output"),
        ]
        return params

    def isLicensed(self):
        return True

    def execute(self, parameters, messages):
        return
