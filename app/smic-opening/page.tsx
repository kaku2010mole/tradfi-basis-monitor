import type { Metadata } from "next";
import OpeningOutlookDashboard from "../components/OpeningOutlookDashboard";
export const metadata:Metadata={title:"Opening Outlook · SMIC, DOOSENER, ZHONGJI & GIGADEV",description:"Switch opening forecasts for SMIC, Doosan Enerbility, Zhongji and GigaDevice using live SMH, EWY, LITE and MU inputs."};
export default function SmicOpeningPage(){return <OpeningOutlookDashboard/>;}
