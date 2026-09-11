-- STYLE: avg watch seconds per user by day + channel
SELECT
  toDate(lastWatchTime) AS watchDate,
  channel,
  round(sum(watchSecond) / nullIf(uniq(guid), 0), 2) AS avg_watch_second
FROM elt_watch_detail
WHERE toDate(lastWatchTime) BETWEEN '{start}' AND '{end}'
  AND channel = '{channel}'
  AND contentLang IN ({langs})
  AND movieType IN ({movieTypes})
GROUP BY watchDate, channel
ORDER BY watchDate, channel
