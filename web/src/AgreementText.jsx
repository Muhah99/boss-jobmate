import React from 'react';

// Render the bundled license documents without rewriting their wording.
export default function AgreementText({text,onLicense}) {
  function inline(value) {
    return value.split(/(\[[^\]]+\]\([^)]+\)|\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|`[^`]+`|<https?:\/\/[^>]+>)/g).map((part,i)=>{
      const link=part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if(link){
        if(link[2]==='LICENSE')return <button key={i} className="agreement-inline-link" onClick={onLicense}>{link[1]}</button>;
        return <a key={i} href={link[2]} target={link[2].startsWith('#')?undefined:'_blank'} rel="noopener noreferrer">{link[1]}</a>;
      }
      if(part.startsWith('***'))return <strong key={i}><em>{part.slice(3,-3)}</em></strong>;
      if(part.startsWith('**'))return <strong key={i}>{part.slice(2,-2)}</strong>;
      if(part.startsWith('`'))return <code key={i}>{part.slice(1,-1)}</code>;
      if(part.startsWith('<http'))return <a key={i} href={part.slice(1,-1)} target="_blank" rel="noopener noreferrer">{part.slice(1,-1)}</a>;
      return part;
    });
  }
  return <article className="usage-agreement-body" tabIndex={0} aria-label="协议全文">{text.trim().split(/\r?\n\s*\r?\n/).map((block,i)=>{
    if(block.startsWith('# '))return <h3 key={i}>{block.slice(2)}</h3>;
    if(block.startsWith('## ')){const heading=block.slice(3);return <h4 key={i} id={heading.toLowerCase().replaceAll(' ','-')}>{heading}</h4>}
    if(block.startsWith('> '))return <blockquote key={i}>{inline(block.slice(2))}</blockquote>;
    return <p key={i}>{inline(block)}</p>;
  })}</article>;
}
