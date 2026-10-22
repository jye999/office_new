# Notes: quirks and suspected bugs found while porting (do not fix; record)

- api.php product routes outside auth groups were unauthenticated in the old app; new app guards them (roles admin,user,remote). Intentional.
- api.php routes duplicated in web.php are shadowed (web wins); only the web.php version is ported.
- /OrderHistory, /SaveOrder, /UpdateShippedOrder, /ProcessOrders point at non-existent controllers; not ported.
- (T03) The old app has no resources/views/errors/404 view, so with APP_DEBUG=true (its .env) a 404 renders Symfony's detailed debug exception page (PHP traces, request meta). The new app serves the production (non-debug) Symfony 404 page: `<h1>404 | Not Found</h1>` + "Whoops, looks like something went wrong." 404 bodies are therefore not asserted in parity.
- (T03) Laravel 5.4 paginate() JSON has no first_page_url/links keys, and `from` goes negative (e.g. -14 for per_page 15) when total is 0. Ported as-is.
- (T04) DatatablesEditor::process "create" action on an Eloquent Builder crashes in the old app (`$model[0]->create()` where $model is a single Model instance → `null->create()` fatal). Ported to throw (500) with the same message. The string/table path of the same method is only used by a commented-out test in the old app.
- (T04) maatwebsite/excel 2.1 returns PHPExcel DateTime objects for date cells; Laravel JSON encodes them as ISO-8601 with microseconds and offset. src/excel.ts emits `toISOString()` (Z, no microseconds). Only affects the two picklist upload routes (Tongtool/Wayfair), which are not parity-tested.
- (T04) yajra v6 `extractColumnName` strips `table.` prefixes from column names before search/order (search is then unqualified). Ported; matters only when a query joins.
