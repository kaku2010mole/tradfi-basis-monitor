"use client";
import { useEffect, useState } from "react";
import SmicOpeningDashboard from "./SmicOpeningDashboard";
import DoosenerOpeningDashboard from "./DoosenerOpeningDashboard";
import styles from "./SmicOpeningDashboard.module.css";

export default function OpeningOutlookDashboard(){
  const [instrument,setInstrument]=useState("smic");
  useEffect(()=>{
    const read=()=>{const value=new URLSearchParams(window.location.search).get("asset");setInstrument(value==="doosener"?"doosener":"smic");};
    read();window.addEventListener("popstate",read);return()=>window.removeEventListener("popstate",read);
  },[]);
  const choose=(value:string)=>{setInstrument(value);const url=new URL(window.location.href);if(value==="smic")url.searchParams.delete("asset");else url.searchParams.set("asset",value);window.history.replaceState(null,"",url);};
  const selector=<div className={styles.instrumentBar}><label htmlFor="opening-instrument">预测标的 · INSTRUMENT<select id="opening-instrument" aria-label="Prediction instrument" value={instrument} onChange={e=>choose(e.target.value)}><option value="smic">SMIC · 00981.HK · 中芯国际</option><option value="doosener">DOOSENER · 034020.KS · 斗山能源</option></select></label><span>{instrument==="smic"?"SMH 实时涨跌幅":"EWY 美国盘中 ＋ SMH 实时涨跌幅"}</span></div>;
  return instrument==="doosener"?<DoosenerOpeningDashboard instrumentControl={selector}/>:<SmicOpeningDashboard instrumentControl={selector}/>;
}
