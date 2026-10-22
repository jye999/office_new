# Task index (run in this order; one at a time)

| id | title | deps | phase |
|---|---|---|---|
| [T00](T00.md) | Scaffold, config, DB layer, static assets |  | 0 |
| [T01](T01.md) | Views engine, Blade helper globals, layouts | T00 | 0 |
| [T02](T02.md) | Auth: login/logout/register/password reset, roles, PDA api-key | T01 | 0 |
| [T03](T03.md) | Router helpers + parity harness | T02 | 0 |
| [T04](T04.md) | Shared helpers: DataTables, Pusher, mail, storage, excel | T03 | 0 |
| [T10](T10.md) | Home report, ActionLog, Settings | T00, T01, T02, T03, T04 | 1 |
| [T11](T11.md) | Timesheet, Staffs | T00, T01, T02, T03, T04 | 1 |
| [T12](T12.md) | Exec, QueueJob, Price | T00, T01, T02, T03, T04 | 1 |
| [T13](T13.md) | Message, UserMessage | T00, T01, T02, T03, T04 | 1 |
| [T14](T14.md) | Chat, Gpt | T00, T01, T02, T03, T04 | 1 |
| [T15](T15.md) | Keywords, Fba | T00, T01, T02, T03, T04 | 1 |
| [T16](T16.md) | Opolo, OpoloCost | T00, T01, T02, T03, T04 | 1 |
| [T17](T17.md) | Windy, Four | T00, T01, T02, T03, T04 | 1 |
| [T18](T18.md) | Item, Itemimage | T00, T01, T02, T03, T04 | 1 |
| [T19](T19.md) | FollowUps | T00, T01, T02, T03, T04 | 1 |
| [T20](T20.md) | Production, Purchase | T00, T01, T02, T03, T04 | 1 |
| [T21](T21.md) | BulkProduction | T00, T01, T02, T03, T04 | 1 |
| [T22a](T22a.md) | Reports: Sales, SalesTax, SalesSnapshot | T00, T01, T02, T03, T04 | 1 |
| [T22b](T22b.md) | Reports: ProductSales, LowInventory(+export), Receiving, CodeGenerator | T00, T01, T02, T03, T04 | 1 |
| [T23](T23.md) | Order (packing, pick list, printing, multi orders) | T00, T01, T02, T03, T04 | 1 |
| [T24](T24.md) | PDA API (/api/pda/*) + api-key regeneration | T00, T01, T02, T03, T04 | 2 |
| [T25a](T25a.md) | Inventory: pages, datatables data, CRUD, response | T00, T01, T02, T03, T04 | 2 |
| [T25b](T25b.md) | Inventory: transfers, upload, consolidation | T00, T01, T02, T03, T04, T25a | 2 |
| [T26](T26.md) | Product: Vue SPA shell + catch-all fallbacks + list/get JSON APIs | T00, T01, T02, T03, T04 | 2 |
| [T27](T27.md) | Product: store/update API, images, locations, mass update/delete, thumbnails | T00, T01, T02, T03, T04, T26 | 2 |
| [T28](T28.md) | Product: resource pages, datatables, ship weight, product map, bulk production | T00, T01, T02, T03, T04, T27 | 2 |
| [T30](T30.md) | SupplierProduct (+ /{Supplier?} fallback), ProductImage, FaireImageImport | T00, T01, T02, T03, T04 | 2 |
| [L01](L01.md) | Stamps (SOAP) client | T00, T01, T02, T03, T04 | 3 |
| [L02](L02.md) | FedEx + UPS clients | T00, T01, T02, T03, T04 | 3 |
| [L03](L03.md) | Frayun + Usps clients | T00, T01, T02, T03, T04 | 3 |
| [L04](L04.md) | Amazon SP-API client | T00, T01, T02, T03, T04 | 3 |
| [L05](L05.md) | eBay clients | T00, T01, T02, T03, T04 | 3 |
| [L06](L06.md) | Etsy client + OAuth | T00, T01, T02, T03, T04 | 3 |
| [L07](L07.md) | Shopify client | T00, T01, T02, T03, T04 | 3 |
| [L08](L08.md) | Walmart client | T00, T01, T02, T03, T04 | 3 |
| [L09](L09.md) | Houzz + Wayfair clients | T00, T01, T02, T03, T04 | 3 |
| [L10](L10.md) | Remaining libraries used by in-scope code | T00, T01, T02, T03, T04 | 3 |
| [T40](T40.md) | Carrier routes: Stamps, Fedex, Ups, Frayun | T00, T01, T02, T03, T04, L01, L02, L03 | 3 |
| [T41](T41.md) | Wayfair, Tongtool routes | T00, T01, T02, T03, T04, L09 | 3 |
| [T42](T42.md) | Marketplace callbacks: Etsy, Ebay, Shopify, AmzAd | T00, T01, T02, T03, T04, L04, L05, L06, L07 | 3 |
| [T43](T43.md) | Product: marketplace links/imports | T00, T01, T02, T03, T04, T28, L04, L05, L06, L07 | 3 |
| [U1](U1.md) | Unshipped store pages 1–5, enfloral, refreshNotes | T00, T01, T02, T03, T04, L04, L05, L06, L07, L09 | 4 |
| [U2](U2.md) | Unshipped store pages 6–13 | T00, T01, T02, T03, T04, L04, L05, L06, L07, L09, U1 | 4 |
| [U3](U3.md) | Unshipped store 90/91/92/101, Faire store | T00, T01, T02, T03, T04, L04, L05, L06, L07, L09, U2 | 4 |
| [U4](U4.md) | Faire pick list + allocations | T00, T01, T02, T03, T04, L04, L05, L06, L07, L09, U3 | 4 |
| [U5](U5.md) | Summary, processed, search, packing list, all unshipped, pending | T00, T01, T02, T03, T04, L04, L05, L06, L07, L09, U4 | 4 |
| [U6](U6.md) | Order actions (notes, assign, priority, done, cache) | T00, T01, T02, T03, T04, L04, L05, L06, L07, L09, U5 | 4 |
| [U7](U7.md) | Labels and printing | T00, T01, T02, T03, T04, L04, L05, L06, L07, L09, U6 | 4 |
| [U8](U8.md) | Tracking | T00, T01, T02, T03, T04, L04, L05, L06, L07, L09, U7 | 4 |
| [U9](U9.md) | eBay order/item/image actions | T00, T01, T02, T03, T04, L04, L05, L06, L07, L09, U8 | 4 |
| [U10](U10.md) | Amazon/Shopify/Etsy/Houzz actions, descriptions, test endpoints | T00, T01, T02, T03, T04, L04, L05, L06, L07, L09, U9 | 4 |
| [J1](J1.md) | Scheduler + queue infrastructure | T00, T01, T02, T03, T04 | 5 |
| [J2](J2.md) | Sync actions: Amazon (orders report, shipped, inventory, images, FBA reports) | J1 | 5 |
| [J3](J3.md) | Sync actions: eBay | J1 | 5 |
| [J4](J4.md) | Sync actions: Walmart | J1 | 5 |
| [J5](J5.md) | Sync actions: Shopify, Houzz, Etsy | J1 | 5 |
| [J6](J6.md) | Sync actions: windy, mermaid, stats, email reports, thumbnails, recal-inv, remaining | J1 | 5 |
| [C1](C1.md) | Full parity sweep + cutover runbook | U10, J6, T43 | 6 |
