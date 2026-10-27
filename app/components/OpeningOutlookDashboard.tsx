"use client";
import { useEffect, useState } from "react";
import SmicOpeningDashboard from "./SmicOpeningDashboard";
import DoosenerOpeningDashboard from "./DoosenerOpeningDashboard";
import HkPeerOpeningDashboard from "./HkPeerOpeningDashboard";
import { isPeerAsset } from "../lib/hkPeerOpening";
import styles from "./SmicOpeningDashboard.module.css";

export default function OpeningOutlookDashboard(){
  const [instrument,setInstrument]=useState("smic");
  useEffect(()=>{
    const read=()=>{const value=new URLSearchParams(window.location.search).get("asset");setInstrument(value==="doosener"||isPeerAsset(value)?value:"smic");};
    read();window.addEventListener("popstate",read);return()=>window.removeEventListener("popstate",read);
  },[]);
  const choose=(value:string)=>{setInstrument(value);const url=new URL(window.location.href);if(value==="smic")url.searchParams.delete("asset");else url.searchParams.set("asset",value);window.history.replaceState(null,"",url);};
  const description=instrument==="smic"?"SMH 实时涨跌幅":instrument==="doosener"?"EWY 美国盘中 ＋ SMH 实时涨跌幅":instrument==="zhongji"?"LITE 美国盘中 ＋ SMH 实时涨跌幅":"MU 美国盘中 ＋ SMH 实时涨跌幅";
  const selector=<div className={styles.instrumentBar}><label htmlFor="opening-instrument">预测标的 · INSTRUMENT<select id="opening-instrument" aria-label="Prediction instrument" value={instrument} onChange={e=>choose(e.target.value)}><option value="smic">SMIC · 00981.HK · 中芯国际</option><option value="doosener">DOOSENER · 034020.KS · 斗山能源</option><option value="zhongji">ZHONGJI · 03308.HK · 中际旭创</option><option value="gigadev">GIGADEV · 03986.HK · 兆易创新</option></select></label><span>{description}</span></div>;
  return isPeerAsset(instrument)?<HkPeerOpeningDashboard key={instrument} asset={instrument} instrumentControl={selector}/>:instrument==="doosener"?<DoosenerOpeningDashboard instrumentControl={selector}/>:<SmicOpeningDashboard instrumentControl={selector}/>;
}
