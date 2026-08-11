var e={name:`Safentia`,accent:`#D9C554`},t={background:`#F7F8FA`,surface:`#FFFFFF`,border:`#D8DCE3`,text:`#10141A`,textSecondary:`#4A525E`,textMuted:`#737C89`},n=`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`,r=`#FFFFFF`,i=`#10141A`;function a(e){let t=e.trim().replace(/^#/,``),n=t.length===3?t.split(``).map(e=>e+e).join(``):t;if(!/^[0-9a-fA-F]{6}$/.test(n))throw Error(`Invalid hex colour: "${e}"`);return{r:parseInt(n.slice(0,2),16),g:parseInt(n.slice(2,4),16),b:parseInt(n.slice(4,6),16)}}function o({r:e,g:t,b:n}){let r=e=>{let t=e/255;return t<=.03928?t/12.92:((t+.055)/1.055)**2.4};return .2126*r(e)+.7152*r(t)+.0722*r(n)}function s(e,t){let n=o(a(e)),r=o(a(t));return(Math.max(n,r)+.05)/(Math.min(n,r)+.05)}function c(e){try{return s(r,e)>=s(i,e)?r:i}catch{return r}}function l(e){return e.replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`).replace(/'/g,`&#39;`)}function u(e){return l(e).replace(/\r?\n/g,`<br>`)}function d(r){let i=r.brand??e,a=l(i.name),o=l(i.accent),s=l(c(i.accent)),d=r.preheader?`<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${l(r.preheader)}</div>`:``,f=r.paragraphs.map(e=>`<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:${t.textSecondary};">${u(e)}</p>`).join(`
`),p=r.detailRows?.length?`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px 0;border:1px solid ${t.border};border-radius:10px;background:${t.background};">
${r.detailRows.map(e=>`        <tr>
          <td style="padding:10px 16px 2px 16px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${t.textMuted};font-family:${n};">${l(e.label)}</td>
        </tr>
        <tr>
          <td style="padding:0 16px 10px 16px;font-size:15px;line-height:1.5;color:${t.text};font-family:${n};">${u(e.value)}</td>
        </tr>`).join(`
`)}
      </table>`:``,m=r.cta?`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 24px 0;">
        <tr>
          <td style="background:${o};border-radius:10px;">
            <a href="${l(r.cta.url)}" style="display:inline-block;padding:12px 28px;font-family:${n};font-size:15px;font-weight:600;color:${s};text-decoration:none;">${l(r.cta.label)}</a>
          </td>
        </tr>
      </table>`:``;return`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${l(r.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${t.background};">
${d}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.background};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:${t.surface};border:1px solid ${t.border};border-radius:14px;overflow:hidden;">
        <tr>
          <td style="height:4px;background:${o};font-size:0;line-height:0;">&nbsp;</td>
        </tr>
        <tr>
          <td style="padding:28px 32px 0 32px;font-family:${n};">
            <span style="font-size:19px;font-weight:700;letter-spacing:-0.02em;color:${t.text};">${a}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 0 32px;font-family:${n};">
            <h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.3;letter-spacing:-0.01em;color:${t.text};">${l(r.heading)}</h1>
${f}
${p}
${m}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 28px 32px;border-top:1px solid ${t.border};font-family:${n};">
            <p style="margin:0;font-size:12px;line-height:1.6;color:${t.textMuted};">${l(r.footerNote)}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`}export{d as n,e as t};
//# sourceMappingURL=emailHtml-BuHBwtEG.js.map