const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PersonalLibrary } = require("../dist/shared/personal-library.js");
function song(id, source="netease") {
  return {id,source,source_track_id:String(id),title:"歌曲 "+id,artist:"测试歌手",
    album:"测试专辑",cover_url:"",duration:180,audio_kind:"full"};
}
function row(id,source="netease") {
  return {key:source+":"+id,at:1700000000000+id,song:song(id,source),sourceName:"酷我音乐"};
}
function make(restore=async(saved)=>({...saved,id:Number(saved.source_track_id),audio_kind:"full"})) {
  const listeners=new Set(),views=[],calls=[];
  const store={data:{favorite:Array.from({length:25},(_,i)=>row(i+1)),like:[row(30)],recent:{items:[row(40)]}},
    subscribe(fn){listeners.add(fn);fn(this.data);return ()=>listeners.delete(fn);},
    emit(){for(const fn of listeners)fn(this.data);},
    remove:async(...args)=>calls.push(["remove",...args]),
    mark:async(...args)=>calls.push(["mark",...args]),
    clear:async(...args)=>calls.push(["clear",...args]),
  };
  const player={state:{current:null},play:async(...args)=>calls.push(["play",...args]),
    toggle:async()=>calls.push(["toggle"])};
  const library=new PersonalLibrary((view)=>views.push(view),restore,()=>player,()=>calls.push(["open"]));
  library.show(store);
  return {library,store,views,calls,player,listeners};
}
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};

test("three inline tabs switch from existing data, preserve per-tab pagination and do not resolve, navigate or touch audio",()=>{
  const {library,store,calls,views}=make();
  assert.equal(library.state.total,25);assert.equal(library.state.items.length,20);
  library.next();assert.equal(library.state.page,2);assert.equal(library.state.items.length,5);
  library.select("like");assert.equal(library.state.total,1);assert.equal(library.state.items[0].song.title,"歌曲 30");
  library.select("recent");assert.equal(library.state.items[0].sourceLabel,"酷我音乐");
  library.select("favorite");assert.equal(library.state.page,2);
  library.select("invalid");assert.equal(library.state.kind,"favorite");
  store.data.favorite=[];store.emit();assert.equal(library.state.total,0);assert.equal(library.state.page,1);
  assert.deepEqual(calls,[]);assert.ok(views.length>4);
});

test("a pending restore is ignored after tab switch or hide, while saved history stays intact",async()=>{
  for(const action of ["tab","hide","remove"]){
    const pending=deferred();const {library,store,calls}=make(()=>pending.promise);
    const play=library.play("netease:1");
    assert.equal(library.state.loading,true);
    if(action==="tab")library.select("recent");
    else if(action==="hide")library.hide();
    else {store.data.favorite=store.data.favorite.filter((x)=>x.key!=="netease:1");store.emit();}
    pending.resolve(song(1));await play;
    assert.deepEqual(calls,[]);assert.equal(library.state.loading,false);
    if(action!=="remove")assert.equal(store.data.favorite.length,25);
  }
});

test("fast personal song changes ignore old resolves, reuse current playback and retain unavailable records",async()=>{
  const first=deferred(),second=deferred();let n=0;
  const {library,calls,player,store}=make(()=>++n===1?first.promise:second.promise);
  const a=library.play("netease:1"),b=library.play("netease:2");
  second.resolve(song(2));await b;first.resolve(song(1));await a;
  assert.equal(calls.filter((x)=>x[0]==="play").length,1);
  assert.equal(calls[0][1].source_track_id,"2");
  player.state.current=song(2);await library.play("netease:2");
  assert.equal(calls.at(-2)[0],"toggle");assert.equal(n,2);
  const broken=make(async()=>{throw new Error("当前没有完整版");});
  await broken.library.play("netease:1");
  assert.equal(broken.store.data.favorite.length,25);
  assert.match(broken.library.state.items[0].availability,/保留/);
  assert.equal(broken.calls.length,0);
});

test("remove and clear operate on the selected kind and subscriptions are released without stopping music",async()=>{
  const {library,calls,listeners,store}=make();
  await library.remove("netease:1");assert.deepEqual(calls[0],["mark","favorite",store.data.favorite[0].song,false]);
  library.select("like");await library.remove("netease:30");assert.equal(calls[1][1],"like");
  library.clearRecent();assert.equal(calls.length,2);
  library.select("recent");await library.remove("netease:40");library.clearRecent();
  assert.deepEqual(calls[2],["remove","recent","netease:40"]);assert.deepEqual(calls[3],["clear","recent"]);
  assert.equal(listeners.size,1);library.hide();assert.equal(listeners.size,0);
  library.show(store);assert.equal(listeners.size,1);library.hide();assert.equal(listeners.size,0);
  assert.ok(!calls.some((x)=>["play","toggle","open"].includes(x[0])));
});

test("mine template presents three tabs, inline rows, chosen-avatar entry and state-aware guest guidance",()=>{
  const root=path.resolve(__dirname,"../src/pages/mine");
  const markup=fs.readFileSync(path.join(root,"index.wxml"),"utf8");
  const source=fs.readFileSync(path.join(root,"index.ts"),"utf8");
  assert.equal((markup.match(/aria-role="tab"/g)||[]).length,3);
  for(const kind of ["favorite","like","recent"])
    assert.ok(markup.includes('data-kind="'+kind+'" bindtap="changeTab"'));
  assert.ok(markup.includes('aria-role="tabpanel"'));
  assert.ok(markup.includes('wx:for="{{items}}"'));
  assert.ok(markup.includes('catchtap="remove"'));
  assert.ok(markup.includes('disabled="{{page <= 1}}"'));
  assert.ok(markup.includes('disabled="{{!hasMore}}"'));
  assert.ok(!source.includes("routes.library")&&!markup.includes('bindtap="openList"'));
  assert.ok(markup.includes('binderror="avatarFailed"'));
  assert.ok(markup.includes("访客模式"));assert.ok(!markup.includes("未启用时，搜索和播放历史"));
  assert.ok(markup.includes("<player-bar/>"));
});
