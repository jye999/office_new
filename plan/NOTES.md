# Notes: quirks and suspected bugs found while porting (do not fix; record)

- api.php product routes outside auth groups were unauthenticated in the old app; new app guards them (roles admin,user,remote). Intentional.
- api.php routes duplicated in web.php are shadowed (web wins); only the web.php version is ported.
- /OrderHistory, /SaveOrder, /UpdateShippedOrder, /ProcessOrders point at non-existent controllers; not ported.
