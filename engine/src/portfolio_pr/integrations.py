"""Optional external adapters. No paid API access without an explicitly supplied key and budget."""
from __future__ import annotations
import base64
import json
import os
import time
from datetime import datetime,timezone
from email.message import EmailMessage
from urllib.parse import quote
import requests


class NotConfigured(RuntimeError): pass


class BraveSearch:
    """Returns web search candidates; search snippets are not publication or contact evidence."""
    def __init__(self,api_key: str | None=None,session=None):
        self.api_key=api_key or os.getenv('BRAVE_API_KEY','')
        self.session=session or requests.Session()

    def search(self,query:str,count:int=10):
        if not self.api_key: raise NotConfigured('BRAVE_API_KEY not set; competitor CSV import still works')
        response=self.session.get('https://api.search.brave.com/res/v1/web/search',
                params={'q':query,'count':min(max(count,1),20),'safesearch':'strict'},
                headers={'Accept':'application/json','X-Subscription-Token':self.api_key},timeout=(5,12))
        response.raise_for_status()
        body=response.json()
        return [{'url':i.get('url',''),'title':i.get('title',''),'snippet':i.get('description','')}
                for i in body.get('web',{}).get('results',[])]


class GmailAPI:
    """Official OAuth Gmail API; never reuse ChatGPT connector credentials or infer delivery from Sent."""
    def __init__(self, client_id=None,client_secret=None,refresh_token=None,session=None):
        self.client_id=client_id or os.getenv('GMAIL_CLIENT_ID','')
        self.client_secret=client_secret or os.getenv('GMAIL_CLIENT_SECRET','')
        self.refresh_token=refresh_token or os.getenv('GMAIL_REFRESH_TOKEN','')
        self.session=session or requests.Session()
        self.token=''
        self.token_expires_at=0.0

    def configured(self):
        return all((self.client_id,self.client_secret,self.refresh_token))

    def _token(self):
        if not self.configured():raise NotConfigured('Gmail OAuth client/secret/refresh token not provisioned on worker')
        # v3 cached OAuth access tokens forever; long-running workers failed after ~1h.
        if self.token and time.monotonic()<self.token_expires_at-90:return self.token
        response=self.session.post('https://oauth2.googleapis.com/token',data={
           'grant_type':'refresh_token','client_id':self.client_id,
           'client_secret':self.client_secret,'refresh_token':self.refresh_token},timeout=(5,12))
        response.raise_for_status()
        data=response.json()
        self.token=data['access_token']
        self.token_expires_at=time.monotonic()+max(180,int(data.get('expires_in',3600)))
        return self.token

    def _get(self,path,params=None):
        response=self.session.get('https://gmail.googleapis.com/gmail/v1/users/me/'+path,
                   params=params,headers={'Authorization':'Bearer '+self._token()},timeout=(5,12))
        response.raise_for_status();return response.json()

    def mx_status(self,email: str):
        """Domain-level MX health only. Presence never proves the individual mailbox exists.
        Fail closed on DNS timeouts or malformed server answers. Does not use SMTP probing.
        """
        domain=email.rsplit('@',1)[-1].lower().strip()
        if '@' not in email or '.' not in domain:
            return 'invalid_email'
        try:
            r=self.session.get('https://dns.google/resolve',
                params={'name':domain,'type':'MX'},timeout=(5,10),headers={'Accept':'application/dns-json'})
            r.raise_for_status();data=r.json()
            if data.get('Status')!=0:return 'dns_error'
            answers=data.get('Answer') or []
            return 'mx_present' if any(x.get('type')==15 and x.get('data') for x in answers) else 'no_mx'
        except (requests.RequestException,ValueError,KeyError):return 'dns_unknown'

    def find_contact_history(self,email:str):
        if not email:return False
        # Messages received and sent from this authenticated mailbox only; other accounts require separate checks.
        query=f'{{to:{email} from:{email}}} -in:drafts'
        data=self._get('messages',{'q':query,'maxResults':1})
        return bool(data.get('messages'))

    def find_publisher_history(self,publisher_domain:str)->bool:
        """Search SENT history for ANY recipient at the publisher domain.

        A second editor in the same organization is not a new backlink prospect.
        Gmail search syntax is not proof of contact when the provider is down.
        """
        from .engine import reg_domain
        domain=reg_domain(publisher_domain)
        if not domain or '.' not in domain:raise ValueError('publisher domain required')
        result=self._get('messages',{'q':f'in:sent to:(@{domain}) -in:drafts','maxResults':1})
        return bool(result.get('messages'))

    def recent_sent_count(self,days:int=7,portfolio_domains=None):
        """Count campaign-relevant Gmail sends, not unrelated personal emails.

        Query [BLF] messages and existing portfolio link mentions. Paginate to prevent
        cap circumvention on busy accounts. Does not cover other Gmail accounts.
        """
        from datetime import timedelta
        date=(datetime.now(timezone.utc)-timedelta(days=days)).strftime('%Y/%m/%d')
        terms=['subject:[BLF]']
        for domain in (portfolio_domains or []):
            if domain and domain.replace('.','').replace('-','').isalnum():
                terms.append('"'+domain.strip().lower()+'"')
        query=f"in:sent after:{date} {{ {' '.join(terms)} }}"
        count=0;token=None
        while True:
            params={'q':query,'maxResults':100}
            if token:params['pageToken']=token
            page=self._get('messages',params)
            count+=len(page.get('messages',[]))
            token=page.get('nextPageToken')
            if not token:return count
            if count>=1000:
                raise RuntimeError('Gmail portfolio sent pagination exceeded 1000; pause before sending')

    def _mime(self,to_address:str,subject:str,body:str,in_reply_to:str=''):
        message=EmailMessage()
        message['To']=to_address
        message['Subject']=subject
        if in_reply_to:
            message['In-Reply-To']=in_reply_to
            message['References']=in_reply_to
        message.set_content(body)
        return base64.urlsafe_b64encode(message.as_bytes()).decode().rstrip('=')

    def create_draft(self,to_address:str,subject:str,body:str,thread_id:str='',in_reply_to:str=''):
        """Create actual Gmail Drafts. Requires OAuth gmail.compose; NEVER sends."""
        raw=self._mime(to_address,subject,body,in_reply_to)
        msg={'raw':raw}
        if thread_id:msg['threadId']=thread_id
        response=self.session.post('https://gmail.googleapis.com/gmail/v1/users/me/drafts',
                       headers={'Authorization':'Bearer '+self._token(),'Content-Type':'application/json'},
                       json={'message':msg},timeout=(5,12))
        response.raise_for_status();payload=response.json()
        if not payload.get('id'):raise RuntimeError('Gmail drafts.create returned no ID; reconcile before retrying')
        return payload['id']

    def send_draft(self,draft_id:str):
        """Send the already-synced Gmail draft, not a duplicate newly constructed message."""
        if not draft_id:raise ValueError('Missing Gmail draft ID')
        response=self.session.post('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send',
                headers={'Authorization':'Bearer '+self._token(),'Content-Type':'application/json'},
                json={'id':draft_id},timeout=(5,12))
        response.raise_for_status();payload=response.json()
        if not payload.get('id'):raise RuntimeError('Draft sent response lacks message ID; reconcile before retrying')
        return payload['id']

    def thread_for_message(self,message_id:str):
        """Read the original sent message and its Gmail thread metadata."""
        meta=self._get('messages/'+quote(message_id,safe=''),{'format':'metadata',
                              'metadataHeaders':['Message-ID','From','To','Subject']})
        thread_id=meta.get('threadId')
        if not thread_id: raise RuntimeError('Gmail message has no threadId')
        thread=self._get('threads/'+quote(thread_id,safe=''),{'format':'metadata',
                              'metadataHeaders':['Message-ID','From','To','Subject']})
        return {'original':meta,'thread':thread,'thread_id':thread_id}

    def send(self,to_address:str,subject:str,body:str,from_name:str):
        if not self.configured():raise NotConfigured('Gmail OAuth required for unattended sending')
        # From address is intentionally not forged; Gmail authenticated alias applies automatically.
        raw=self._mime(to_address,subject,body)
        result=self.session.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
                       headers={'Authorization':'Bearer '+self._token(),'Content-Type':'application/json'},
                       json={'raw':raw},timeout=(5,12))
        result.raise_for_status()
        payload=result.json()
        if not payload.get('id'):raise RuntimeError('Gmail send returned no message ID; manual reconciliation required')
        return payload['id']
