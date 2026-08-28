import { chromium } from 'playwright'
import fs from 'node:fs'
const env = fs.readFileSync('.context/secrets/e2e.env','utf8')
const password = env.match(/NEXUS_E2E_PASSWORD=(.*)/)[1]
const login = await (await fetch('http://127.0.0.1:59000/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})})).json()
const browser = await chromium.launch({headless:true, executablePath:"/usr/bin/google-chrome"})
const context = await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36'})
await context.addInitScript(({token, session, index})=>{
 localStorage.setItem('nexus_guide_seen','true')
 localStorage.setItem('nexus_token',token)
 localStorage.setItem('nexus_session',session)
 localStorage.setItem('nexus_session_source','user')
 localStorage.setItem('nexus_window',String(index))
 localStorage.setItem('nexus_window_'+session,String(index))
}, {token:login.token, session:'home-demo-workspace', index:1})
const page=await context.newPage()
const logs=[]
page.on('console',m=>logs.push(m.text()))
await page.goto('http://127.0.0.1:59000/',{waitUntil:'domcontentloaded'})
await page.waitForSelector('.xterm', {timeout:30000})
await page.waitForTimeout(5000)
const waitGrok = await page.evaluate(()=>new Promise(r=>setTimeout(r,10000)).then(()=>1));
const info1=await page.evaluate(()=>{
 const vp=document.querySelector('.xterm-viewport')
 const t=window.termRef?.current
 const buf=t?.buffer?.active
 return {sel:vp?'yes':'no', scrollTop:vp?.scrollTop, scrollHeight:vp?.scrollHeight, clientHeight:vp?.clientHeight, viewportY:buf?.viewportY, baseY:buf?.baseY, cols:t?.cols, rows:t?.rows}
})
const before=await page.evaluate(()=>{const v=document.querySelector('.xterm-viewport'); return {scrollTop:v?.scrollTop, sh:v?.scrollHeight,ch:v?.clientHeight}})
await page.mouse.move(200,500)
await page.mouse.wheel(0,-500)
await page.waitForTimeout(1000)
const after=await page.evaluate(()=>{const v=document.querySelector('.xterm-viewport'); return {scrollTop:v?.scrollTop, sh:v?.scrollHeight,ch:v?.clientHeight}})
await page.screenshot({path:'/tmp/grok-scroll.png'})
console.log(JSON.stringify({info1,before,after,logs:logs.slice(-10)},null,2))
await browser.close()
