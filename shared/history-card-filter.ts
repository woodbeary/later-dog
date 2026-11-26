export const historyUnansweredCardSql =
  "json_type(messages.json,'$.card')='object' AND COALESCE(json_extract(messages.json,'$.card.dismissed'),0)=0 AND (COALESCE(json_extract(messages.json,'$.card.answered'),'') IN ('',0) OR EXISTS(SELECT 1 FROM history_values WHERE relation='messages' AND entry=CAST(messages.rowid AS TEXT) AND field='json'))";
