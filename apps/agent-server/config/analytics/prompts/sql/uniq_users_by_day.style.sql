-- STYLE: uniq users by day for one channel
SELECT
  toDate(lastWatchTime) AS watchDate,
  uniq(guid) AS users
FROM elt_watch_detail
WHERE toDate(lastWatchTime) BETWEEN '{start}' AND '{end}'
  AND channel = '{channel}'
  AND movieType IN ({movieTypes})
GROUP BY watchDate
ORDER BY watchDate
