"""Version-1 supported export keys, mirrored from lib/ecus-export.ts.

These are the application's bounded transfer contract, not a complete EDA schema.
Tests compare this list with the TypeScript source to detect contract drift.
"""
HEADERS = (
    "declarationType", "customsOffice", "transportMode", "exporterCode",
    "exporterName", "exporterAddress", "exporterTelephone", "importerName",
    "importerAddress", "importerCountry", "customsAgentCode", "cargoIdentification",
    "packageCount", "packageUnit", "grossWeight", "grossWeightUnit", "storageLocation",
    "transportName", "transportCode", "departureDate", "loadingLocationCode",
    "loadingLocationName", "unloadingLocationCode", "unloadingLocationName",
    "invoiceForm", "invoiceNumber", "invoiceDate", "paymentMethod", "incoterm",
    "currency", "invoiceTotal", "contractNumber", "contractDate",
    "previousDeclarationNumber", "remarks",
)
GOODS = ("description", "hsCode", "origin", "quantity", "unit", "unitPrice",
         "amount", "goodsCode", "previousDeclarationLine")


def complete_form(form):
    return {"headers": {key: form["headers"].get(key, "") for key in HEADERS},
            "goods": [{key: row.get(key, "") for key in GOODS} for row in form["goods"]]}
