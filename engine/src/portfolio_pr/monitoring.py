"""Hourly incoming-reply monitoring with evidence-level classifications.

Never guesses that a human reply is a link or editorial acceptance. Never sends.
"""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
import re
from .engine import utc_now, reg_domain
from .integrations import GmailAPI


def _hdr(msg,name):
    return next((v.get('value','') for v in msg.get('payload',{}).get('headers',[])
                if v.get('name','').lower()==name.lower()),'')


def _external_message(message,original_id,recipient,publisher_domain):
    if message.get('id')==original_id or 'SENT' in message.get('labelIds',[]):return False
    sender=_hdr(message,'from').lower()
    if not sender or any(x in sender for x in ('mailer-daemon','noreply','no-reply','postmaster','bounce@')):
        return False
    emails=re.findall(r'[a-zA-Z0-9_.+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}',sender)
    return any(address==recipient.lower() or reg_domain(address.split('@',1)[1])==reg_domain(publisher_domain) for address in emails)


def monitor_replies(engine,*,gmail=None,limit=25):
    gmail=gmail or GmailAPI()
    if not gmail.configured():return {'checked':0,'new_replies':0,'opt_outs':0,'blocked':'Gmail OAuth not provisioned'}
    since=(datetime.now(timezone.utc)-timedelta(days=35)).isoformat()
    rows=engine.conn.execute('''SELECT m.candidate_id,m.to_address,m.gmail_id,m.sent_at,
                 c.publisher_domain,sc.checked_at,sc.last_message_id
           FROM messages m JOIN candidates c ON c.id=m.candidate_id
           LEFT JOIN thread_scans sc ON sc.candidate_id=m.candidate_id
           WHERE m.status='sent' AND m.sent_at>=?
           ORDER BY CASE WHEN sc.checked_at IS NULL THEN 0 ELSE 1 END,sc.checked_at ASC
           LIMIT ?''',(since,limit)).fetchall()
    report={'checked':0,'new_replies':0,'opt_outs':0,'blocked':[], 'events':[]}
    for row in rows:
        if engine.is_suppressed(row['to_address'],row['publisher_domain']):continue
        try:
            thread=gmail.thread_for_message(row['gmail_id'])
            report['checked']+=1
            raw=thread['thread'].get('messages') or []
            external=[m for m in raw if _external_message(m,row['gmail_id'],row['to_address'],row['publisher_domain'])]
            for m in external:
                if engine.conn.execute('SELECT 1 FROM outcomes WHERE candidate_id=? AND outcome IN (\'reply_received\',\'opt_out\') AND evidence=?',
                                       (row['candidate_id'],'Gmail:'+m.get('id',''))).fetchone():
                    continue
                snippet=(m.get('snippet') or '').strip().lower()
                # Explicit opt-out is a do-not-contact instruction; check only own visible first line.
                opt_out=bool(re.match(r'^(?:hi[,.]?\s*)?(?:please\s+)?(?:remove me|unsubscribe|stop emailing|do not contact|do not email|take me off)',snippet))
                event='opt_out' if opt_out else 'reply_received'
                engine.record_outcome(row['candidate_id'],event,'Gmail:'+m['id'])
                if opt_out:
                    engine.suppress(row['publisher_domain'],'External opt-out from contacted publisher','Gmail:'+m['id'])
                    report['opt_outs']+=1
                else:
                    report['new_replies']+=1
                report['events'].append({'candidate':row['candidate_id'],'type':event,'gmail_message_id':m['id']})
            engine.conn.execute('''INSERT INTO thread_scans(candidate_id,checked_at,thread_id,external_count,last_message_id)
               VALUES(?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET
               checked_at=excluded.checked_at,thread_id=excluded.thread_id,
               external_count=excluded.external_count,last_message_id=excluded.last_message_id''',
               (row['candidate_id'],utc_now(),thread['thread_id'],len(external),raw[-1].get('id','') if raw else ''))
            engine.conn.commit()
        except Exception as exc:
            # Never retry send due to read error. Continue monitoring other recipients.
            engine.log('monitor_unavailable',{'candidate':row['candidate_id'],'error':type(exc).__name__},row['candidate_id'])
            report['blocked'].append({'candidate':row['candidate_id'],'reason':type(exc).__name__})
    engine.log('reply_monitor',report)
    return report
