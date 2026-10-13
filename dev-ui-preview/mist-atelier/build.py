import base64,json,re
F='/data/bambook-frontend/node_modules/@fontsource/'
b64=lambda p,m:f"data:{m};base64,"+base64.b64encode(open(p,'rb').read()).decode()
css=open('src/styles.css').read()
for w in (300,400,500,600): css=css.replace(f'__URB{w}__',b64(F+f'urbanist/files/urbanist-latin-{w}-normal.woff2','font/woff2'))
css=css.replace('__JBM400__',b64(F+'jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2','font/woff2'))
svg=open('assets/mark.svg').read()
inner=re.sub(r'^<svg[^>]*>','',svg).replace('</svg>','')
inner=re.sub(r'<title>.*?</title>','',inner)
imgs={k:b64(f'assets/{k}.webp','image/webp') for k in ('coat','blazer','suit','clay')}
html=open('src/index.html').read()
html=html.replace('__CSS__',css).replace('__JS__',open('src/app.js').read())
html=html.replace('__ICONS__',open('icons.json').read()).replace('__IMG__',json.dumps(imgs)).replace('__MARK__',json.dumps(inner))
html=html.replace('__SPLASHMARK__',f'<svg class="mark" viewBox="0 0 200 200" fill="currentColor">{inner}</svg>')
html=html.replace('__FAVICON__',b64('/data/bambook-frontend/public/brand/bambook-v3-favicon.svg','image/svg+xml'))
open('bambook-mist-atelier-demo.html','w').write(html)
print(len(html)//1024,'KB')
