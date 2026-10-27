import type { Metadata } from "next";
import OpeningOutlookDashboard from "../components/OpeningOutlookDashboard";
export const metadata:Metadata={title:"Opening Outlook · SMIC & DOOSENER",description:"Switch between SMIC and Doosan Enerbility opening forecasts using live SMH and EWY ETF inputs."};
export default function SmicOpeningPage(){return <OpeningOutlookDashboard/>;}
