const vscode=require('vscode');
class RTAPanel{
constructor(c){this.c=c;this.events=[];this.tasks=new Map();this.panel=null}
show(){if(this.panel){this.panel.reveal();return}
this.panel=vscode.window.createWebviewPanel('rtaTimeline','RTA - by niwantha meepage',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true});
this.panel.webview.html=this.getHtml();
this.panel.onDidDispose(()=>{this.panel=null})}
handleRTAEvent(d){
if(!['rta','rta_snapshot'].includes(d.t))return;
if(d.t==='rta'){
this.events.push(d);if(this.events.length>1000)this.events.shift();
if(!this.tasks.has(d.task_id))this.tasks.set(d.task_id,{id:d.task_id,name:d.name,states:[],lastState:d.state,runs:0});
const t=this.tasks.get(d.task_id);t.lastState=d.state;t.states.push({ts:d.ts,state:d.state});if(t.states.length>100)t.states.shift();
this.update()} 
}
update(){if(!this.panel)return;
this.panel.webview.postMessage({type:'update',events:this.events.slice(-500),tasks:Array.from(this.tasks.values())})}
getHtml(){return`<!DOCTYPE html><html><head><style>body{background:#0A0A0B;color:#e4e4e7;font-family:monospace;padding:20px}.task{background:#111113;padding:12px;margin:8px 0;border-radius:8px;border-left:3px solid #3B82F6}</style></head><body><h2>RTA - FreeRTOS Timeline - niwantha meepage - All Picos & ESP32</h2><div id="tasks">Waiting...</div><script>const vscode=acquireVsCodeApi();window.addEventListener('message',e=>{const m=e.data;if(m.type==='update'){document.getElementById('tasks').innerHTML=m.tasks.map(t=>'<div class="task"><b>'+t.name+'</b> - '+t.lastState+' - '+t.states.length+' events</div>').join('')+'<pre>'+JSON.stringify(m.events.slice(-20),null,2)+'</pre>'}})</script></body></html>`}
}
function activateRTA(c){
const p=new RTAPanel(c);
c.subscriptions.push(vscode.commands.registerCommand('micropythonStudio.showRTA',()=>p.show()));
c.subscriptions.push(vscode.commands.registerCommand('micropythonStudio.startRTA',()=>{p.show();vscode.window.showInformationMessage('RTA started - by niwantha meepage')}));
return p}
module.exports={activateRTA,RTAPanel};
