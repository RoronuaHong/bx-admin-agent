-- STYLE: avg_of_max wide pivot（完播率 / 最大进度平均值 · 宽表）
-- 参考形状（值来自对话或 probe，勿当金句）：
-- - 内层：输出维 + 实体键(guid,eid) + 透视维(contentLang)；max(maxWatchProgress)
-- - 外层：仅输出维；sumIf/countIf 按语言拆列
-- - WHERE：时间 + channel + movieType；语言可在内层 IN 或仅靠外层 sumIf 过滤
-- 用户参考写法对齐：
SELECT
  watchDate,
  channel,
  round(sumIf(a, contentLang = 'te-IN') / nullIf(countIf(contentLang = 'te-IN'), 0), 0) AS te_IN,
  round(sumIf(a, contentLang = 'ta-IN') / nullIf(countIf(contentLang = 'ta-IN'), 0), 0) AS ta_IN,
  round(sumIf(a, contentLang = 'ml-IN') / nullIf(countIf(contentLang = 'ml-IN'), 0), 0) AS ml_IN
FROM (
  SELECT
    toDate(lastWatchTime) AS watchDate,
    channel,
    guid,
    eid,
    contentLang,
    max(maxWatchProgress) AS a
  FROM elt_watch_detail
  WHERE toDate(lastWatchTime) BETWEEN '{start}' AND '{end}'
    AND channel IN ('{channel}')
    AND contentLang IN ('te-IN', 'ta-IN', 'ml-IN')
    AND movieType IN ({movieTypes})
  GROUP BY watchDate, channel, guid, eid, contentLang
)
GROUP BY watchDate, channel
ORDER BY watchDate, channel
