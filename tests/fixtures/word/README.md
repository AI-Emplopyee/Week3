`synthetic-invoice.doc` is an original synthetic test document generated with macOS `textutil` for the legacy Word upload tests. It contains an invented invoice number, Vietnamese Unicode text and a tab-separated item table. It contains no customer or shipment data.

The compound-file fixtures in `tests/helpers/word-document.ts` are generated entirely in memory to cover allocation safety, Unicode, text chunking and mini-stream handling without requiring Microsoft Word or LibreOffice on Windows or CI.
