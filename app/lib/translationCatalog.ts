// Locally reviewed UI vocabulary, lazy-loaded only when Chinese is selected.
// Keep symbols, venue brands, numbers, user input and external source text intact.
const catalog = `
TradFi Basis Monitor	TradFi 基差监控
TradFi Monitor	TradFi 监控
JLP Research	JLP 研究
JLP Research dashboard	JLP 研究面板
Dashboard navigation	面板导航
Dashboard pages	所有面板
Open dashboard settings	打开面板设置
Settings	设置
Switch dashboard	切换面板
Live yield, hedging and financing	实时收益、对冲与融资
Basis monitor	基差监控
Midpoint, anchor drift and funding	中间价、基准偏离与资金费率
Oracle monitor	预言机监控
Live price, oracle drift and funding	实时价格、预言机偏离与资金费率
Relative value monitor	相对价值监控
Live relationships and prediction error	实时关联与预测偏差
Compare Futu cash and Binance perp 7709	比较富途现货与 Binance 7709 永续
Cash, perpetual and 005930 hedge sizing	现货、永续与 005930 对冲数量
Stock cross-venue basis	股票跨市场基差
Korea, Japan, Taiwan & U.S. ADR references	韩国、日本、台湾及美国 ADR 参考
Japanese stock estimates	日本股票估值
Cash-anchored estimates and implied returns	现货基准估值与隐含涨跌幅
HK auction basis	港股竞价基差
Futu auction versus Binance perps and Posley ADRs	富途竞价与 Binance 永续、Posley ADR 对比
Dividend calendar	股息日历
Dividends + US, Japan & Korea earnings	股息及美国、日本、韩国财报
Opening outlook · SMIC / DOOSENER	开盘预测 · 中芯国际 / 斗山能源
Live SMH return → next HK open & probabilities	实时 SMH 涨跌幅 → 下次港股开盘及概率
Opening outlook	开盘预测
Opening probabilities	开盘概率
Opening gap	开盘相对昨收涨跌幅
Implied opening price	隐含开盘价
Estimated opening gap	预计开盘涨跌幅
Target regular opening price	目标常规开盘价
Last observed opening	最近观测开盘价
Opening instrument	开盘预测标的
Higher open	高开
Lower open	低开
Unchanged open	平开
Higher	上涨
Lower	下跌
Direction accuracy	方向准确率
Mean gap	平均开盘涨跌幅
Median gap	开盘涨跌幅中位数
95% interval	95% 区间
Historical middle 80%	历史中间 80% 区间
Historical outcome distribution	历史结果分布
Model validation	模型验证
Training observations	训练样本数
Walk-forward MAE	逐日向前验证平均绝对误差
Rolling forecast MAE	滚动预测平均绝对误差
Rolling one calendar year	滚动一年
completed-session predictions	已完成交易日的预测
actual flat opens excluded	已剔除实际平开日
Flat observations are included.	包含平盘样本。
Small cohort: fewer than 20 observations.	小样本：少于 20 次观测。
Observed opening gaps in this joint group.	本联合分组中观测到的开盘涨跌幅。
No matched observations	没有匹配样本
Historical estimates · no execution or profit guarantee	历史估计，不保证成交或盈利
Recalculates every 2 seconds while this page is visible.	页面可见时每 2 秒重新计算。
Change either input to explore a scenario.	调整任一输入，查看情景结果。
Enter each return between −30% and +30%.	每项涨跌幅须在 −30% 至 +30% 之间。
Two-factor scenario calculator	双因子情景计算器
Manual scenario	手动情景
Manual scenario active	手动情景已启用
Use live inputs	使用实时输入
Return to live	返回实时模式
Early-estimate input · not an observed return	早期估计输入，并非实际观测收益率
Assumed flat	假设持平
Estimate frozen	估计已冻结
Regular close fixed	常规收盘基准已固定
Waiting for session inputs	等待交易时段输入
Waiting for target session…	等待目标交易时段…
Waiting for model.	等待模型。
Waiting for daily history	等待日线历史数据
Loading historical groups…	正在加载历史分组…
Checking calendar…	正在核对交易日历…
Market feed temporarily unavailable. Last observations are retained.	行情源暂不可用，已保留最近观测数据。
Market feed unavailable.	行情源不可用。
Live SMH input	实时 SMH 输入
SMH return	SMH 涨跌幅
SMH full day	SMH 全天涨跌幅
EWY intraday	EWY 日内涨跌幅
U.S. session date	美股交易日
HK close anchor	港股收盘基准
Regular close anchor	常规收盘基准
Regular closing price	常规收盘价
Return from target U.S. regular-session open	相对目标美股常规开盘价的涨跌幅
Current return vs regular close anchor	当前相对常规收盘基准涨跌幅
U.S. session · live two-factor estimate	美股时段 · 实时双因子估计
Next Hong Kong open	下次港股开盘
Model, input timing & data sources	模型、输入时间与数据来源
Live quote edges first. Closed-market and Taiwan anchor comparisons are explicitly indicative.	优先显示实时价差机会；休市和台湾基准比较均明确标注为参考值。
Live quote radar	实时价差雷达
No live positive edge	暂无实时正向价差
No fresh comparable BBO route. Cash/ADR and retained perp differences below are indicative.	暂无新鲜且可比较的最优报价路径。下方现货、ADR 及保留永续报价的价差仅供参考。
Card colors: positive spreads ≥1% amber, ≥0.5% teal, including closed-market comparisons. Radar ranks live edges only; INDICATIVE is not executable.	卡片色阶：正价差 ≥1% 为琥珀色、≥0.5% 为青绿色，休市比较同样适用。雷达只排名实时机会；参考价差不可视为可成交报价。
01 / Korea	01 / 韩国
02 / Japan + U.S. night	02 / 日本及美股夜盘
03 / Taiwan · Bitget + cash	03 / 台湾 · Bitget 与现货
KRX cash vs perpetuals	韩国现货与永续对比
TSE cash & U.S. ADR vs Bitget	日本现货、美国 ADR 与 Bitget 对比
Taiwan price comparison	台湾价格对比
All stocks	所有股票
Japan + ADR	日本及 ADR
Korea	韩国
Japan	日本
Taiwan	台湾
United States	美国
Hong Kong	香港
China	中国
Stock / contract	股票 / 合约
Stock cross-venue basis · TradFi Monitor	股票跨市场基差 · TradFi 监控
Cash comparisons	现货比较
Currency conversion	汇率换算
Bitget only · currency conversion	仅 Bitget · 汇率换算
New Korean stock perpetuals	新上市韩国股票永续
KRW equivalent	韩元等值
Live / Pre-open	实时 / 盘前
Cash & trial vs perp	现货、试撮价与永续比较
Change vs close	相对收盘涨跌幅
Perp → TWD / latest cash close	永续折算台币 / 最近现货收盘
Cash / trial price vs Bitget	现货 / 试撮价与 Bitget 对比
Cash BBO midpoint during trading; trial price during auction. Stale inputs suppress the spread. All comparisons are indicative.	交易时使用现货最优买卖中间价，竞价时使用试撮价。数据过期时不显示价差，所有比较仅供参考。
Assumes USDT = USD and 1 Taiwan share per perp price unit; multiplier unverified. Minute-sampled cash and indicative FX are not firm executable quotes.	假设 USDT 等于 USD，且每个永续报价单位对应一股台股，合约乘数尚未核实。每分钟采样的现货及参考汇率不属于确定可成交报价。
Live / pre-open comparison	实时 / 盘前对比
Fugle cash / trial: shared 60s cache. USD/TWD: shared 60s cache, indicative observation; Bitget BBO: 2s. Trial and stale cash never become executable signals. No model adjustment in this tab.	富果现货 / 试撮价共用 60 秒缓存，USD/TWD 共用 60 秒参考汇率缓存，Bitget 最优报价每 2 秒更新。试撮价及过期现货不会成为可成交信号，本标签不作模型调整。
TSM ADR → Taiwan opening outlook	TSM ADR → 台股 09:30 预测
TSM ADR → Taiwan opening outlook · historical study	TSM ADR → 台股 09:30 预测 · 历史统计
TSM ADR opening outlook	TSM ADR 台股 09:30 预测
Overnight study · 09:30 HKT / Taipei	隔夜研究 · 香港 / 台北时间 09:30
Historical cash returns versus the previous close. Not a buy-at-open trading win rate.	历史现货价格相对昨收涨跌幅，并非开盘买入的交易胜率。
Taiwan stock	台湾股票
09:30 vs prior close	09:30 相对昨收
reference days · valid n per stock below	个参考日，各股票有效样本数见下方
reference days · through	个参考日，数据截至
days covered	天有效数据
Avg move	平均涨跌幅
Direction hit	方向命中率
Historical sample	历史样本
Current TSM ADR change	当前 TSM ADR 涨跌幅
opening-study anchor	开盘研究基准
Opening-study anchor observation:	开盘研究基准观测时间：
Session cutoff:	交易日输入截止时间：
09:00 input · locked	09:00 输入 · 已锁定
Pre-open input · updating	盘前输入 · 更新中
Follow ADR	跟随 ADR
Up	上涨
Down	下跌
Either	任一方向
ADR up	ADR 上涨
ADR down	ADR 下跌
ADR move	ADR 变动
Matches input	符合当前输入
Not triggered	未触发
Input unavailable	输入不可用
historical occurrence	历史出现频率
sample days	个样本日
Small sample	小样本
Limited sample	有限样本
Manual historical view · this does not change the current ADR input.	手动查看历史分组，不改变当前 ADR 输入。
No directional input available · showing historical ADR-up cases.	暂无方向输入，显示历史 ADR 上涨情形。
Occurrence = frequency within the historical sample, not a probability that today will reach the threshold. The ≥2% sample is included in ≥1%.	出现频率指历史样本中该情形的占比，不是今天达到阈值的概率。≥2% 的样本包含在 ≥1% 样本内。
Method, sample dates & interpretation	方法、样本日期与解读
Latest refresh exclusions:	本次更新剔除项：
ADR anchor corrections:	ADR 基准修正：
Sample counts:	样本数：
Average move:	平均涨跌幅：
Direction hit:	方向命中率：
ADR input:	ADR 输入：
mean of all qualifying 09:30 cash returns versus the previous daily close, including losing and flat days. The 09:00–09:30 bar close approximates the 09:30 price.	所有符合条件样本的 09:30 现货相对昨收涨跌幅均值，包含亏损与平盘日；使用 09:00–09:30 K 线收盘价近似 09:30 价格。
ADR up and stock above prior close, or ADR down and stock below prior close. Flat stock returns are misses. This is not the return from buying at 09:00. Small samples and 100% hit rates do not establish a reliable future probability.	ADR 上涨且股票高于昨收，或 ADR 下跌且股票低于昨收，即方向命中；平盘计为未命中。这不是 09:00 买入的收益率，小样本或 100% 命中率不能证明可靠的未来概率。
last available observation before 09:00 divided by the last observation at or before the prior Taiwan trading date at 14:00. The input is frozen at 09:00; the separate current ADR quote may continue changing. Unavailable quotes are never treated as zero.	以 09:00 前最近观测值除以前一台湾交易日 14:00 或更早的最近观测值计算。输入在 09:00 冻结，独立的当前 ADR 报价仍可继续变化；缺失报价不会按零处理。
missing or rejected bars are excluded, never counted as zero or as misses. Each stock’s hits/n uses only its valid observations for the selected ADR threshold. The occurrence cards use the full ADR reference sample, so their counts can exceed a stock’s valid n. Hon Hai and MediaTek are conditioned on TSM ADR, not on their own depositary receipts.	缺失或被剔除的 K 线不计入样本，也不计为零或未命中。各股命中数 / 样本数仅使用满足所选 ADR 阈值的有效记录；频率卡片使用完整 ADR 参考样本，因此可能多于某只股票的有效样本。鸿海和联发科的条件变量是 TSM ADR，而非各自存托凭证。
Taiwan stocks. This is a dated research snapshot, not an automatically rolling backtest. The original eight stocks retain their common-date sample; Hon Hai and MediaTek use the available verified half-hour bars on the same date grid. Their shorter coverage is shown beside each stock.	只台股。本研究是注明日期的快照，不是自动滚动回测。原八只股票保留共同日期样本；鸿海与联发科在相同日期网格中使用已核实的半小时 K 线，较短的覆盖范围显示在股票旁。
History: Yahoo Finance extended-hours ADR and Taiwan cash bars; reported corporate-action dates and inconsistent bars excluded. No separate FX control or transaction-cost adjustment. Hourly ADR bars were used in the historical study; current references use available Futu quotes or 5-minute Yahoo bars.	历史来源为 Yahoo Finance 延长时段 ADR 及台湾现货 K 线；已剔除已公布公司行动日和不一致 K 线。未单独控制汇率或调整交易成本。历史研究使用小时 ADR K 线，当前参考使用可用的富途报价或 Yahoo 五分钟 K 线。
Zero-volume daily placeholders are not trading sessions; historical cash outcomes are unchanged.	零成交量的日线占位记录不视为交易日，历史现货结果保持不变。
These dates are not included in occurrence, average-return or hit-rate denominators.	这些日期不计入出现频率、平均收益率或命中率的分母。
Implied KRW price vs latest cash close	永续隐含韩元价格与最近现货收盘对比
Implied TWD price vs latest cash close	永续隐含台币价格与最近现货收盘对比
Implied bid / ask	隐含买价 / 卖价
Latest cash close	最近现货收盘价
Previous cash close	前一现货收盘价
Midpoint vs close	中间价相对收盘涨跌幅
Adjusted cash reference · return is unadjusted	复权现货参考值，涨跌幅未复权
Cash snapshot:	现货快照：
Older reference · awaiting	较早参考值，等待
Retained close · new session pending	保留收盘参考，等待新交易日
Latest cash close unavailable	最近现货收盘价不可用
Waiting for verified cash close	等待核实后的现货收盘价
Korea · perp → KRW	韩国 · 永续折算韩元
Taiwan · perp → TWD	台湾 · 永续折算台币
Current perp	当前永续报价
Indicative conversion	参考换算
Japanese stock estimates · daily close anchors ↗	日本股票估值 · 每日收盘基准 ↗
Live TSE BBO	日本现货实时最优报价
Live U.S. ADR BBO	美国 ADR 实时最优报价
Delayed cash estimate	延迟现货估计
Implied ADR price	隐含 ADR 价格
Implied ADR bid / ask	隐含 ADR 买价 / 卖价
ADR market bid / ask	ADR 市场买价 / 卖价
Implied bid / ask (USD)	隐含买价 / 卖价（USD）
Buy ADR · sell perp	买入 ADR · 卖出永续
Buy perp · sell ADR	买入永续 · 卖出 ADR
Buy KRX · sell	买入韩股 · 卖出
Buy TSE · sell	买入日股 · 卖出
Buy perp · sell	买入永续 · 卖出
Buy	买入
Sell	卖出
Short	做空
Long	做多
Buyable discount	可买入折价
Sellable premium	可卖出溢价
Sell · best bid · largest first	卖出 · 最优买价 · 按偏离排序
Buy · best ask · largest first	买入 · 最优卖价 · 按偏离排序
Trade direction	交易方向
Signal unavailable	信号不可用
Direction unavailable	方向不可用
Waiting for both venues	等待两个市场报价
Quote unavailable	报价不可用
No quote	暂无报价
FX unavailable	汇率不可用
No comparable cash quote	没有可比较的现货报价
Stale prices excluded	已排除过期价格
Not an ADR market quote	并非 ADR 市场报价
No live cash, ADR or FX feed required	无需现货、ADR 或汇率实时数据源
Gross, before fees/funding	毛价差，未扣费用及资金费
KrX route unverified	韩国现货交易路径未核实
AFTER-HOURS BBO	盘后最优报价
Auction book, not yet executable	竞价盘口，尚不可成交
Indicative book	参考盘口
Cash last / incomplete book	现货最新成交 / 盘口不完整
Perp rich	永续溢价
Perp cheap	永续折价
Perp vs	永续对比
Cash BBO mid	现货最优买卖中间价
Last cash trade	现货最近成交价
Cash trade	现货成交价
Trial price	试撮价
Opening auction	开盘竞价
Pre-market	盘前
After-hours	盘后
After-market	盘后
Pre-open	盘前
Regular	常规交易
Closed	休市
Lunch	午休
Holiday	假期休市
Suspended	暂停交易
Halted	停牌
Live BBO	实时最优报价
Live quote	实时报价
Live midpoint	实时中间价
Indicative bar	参考 K 线
Last / indicative	最新值 / 参考
Last observed	最近观测值
Last cash quotes	最近现货报价
Stale reference	参考值过期
Stale perp	永续报价过期
Stale / retained perp	过期 / 保留的永续报价
Feed stale / waiting	行情过期 / 等待中
Waiting / retained	等待中 / 保留值
BBO	最优买卖报价
Bid / ask	买价 / 卖价
Best bid	最优买价
Best ask	最优卖价
Bid	买价
Ask	卖价
Midpoint	中间价
Oracle price	预言机价格
Mark price	标记价格
Index price	指数价格
Market price	市场价格
Last price	最新价
Fair price	合理价格
Theoretical fair price	理论合理价格
Price deviation	价格偏离
Prediction error	预测偏差
Deviation	偏离
Funding history	资金费率历史
Funding rate	资金费率
Funding	资金费率
Funding interval	资金费间隔
Next funding	下次资金费结算
Next settlement	下次结算
Alert threshold	提醒阈值
Threshold	阈值
Signal	信号
Opportunity	机会
Positive spreads	正向价差
Positive edges	正向价差机会
Executable edge	可成交价差
Spread	价差
Premium	溢价
Discount	折价
Price	价格
Volume	成交量
Size	数量
Oracle	预言机
Perpetuals	永续合约
Perpetual	永续合约
Perps	永续合约
Perp	永续
Cash	现货
Spot	现货
Reference FX	参考汇率
Reference	参考值
FX	汇率
Ordinary shares	普通股
Shares per contract	每份合约股数
Shares to hedge	需要对冲的股数
Shares	股
Units	份
Multiplier	乘数
Anchor	基准
Hedge sizing	对冲数量
Hedge ratio	对冲比例
FX exposure	汇率敞口
Exposure	敞口
Current	当前
Current quote	当前报价
Current rate	当前费率
Updated	已更新
Updating	更新中
Scanning	扫描中
Connecting	连接中
Connecting live	正在连接实时行情
Connected	已连接
Reconnecting	重新连接中
Waiting	等待中
Stale	已过期
Unavailable	不可用
Partial data	数据不完整
Partial	部分可用
Live	实时
Indicative	仅供参考
Not cash	并非现货报价
Not substituted	未使用替代值
Not executed	未执行交易
No data	暂无数据
No records	暂无记录
No results	没有结果
Loading	加载中
Loading history	正在加载历史
Loading historical study…	正在加载历史统计…
Loading historical data	正在加载历史数据
Waiting for data	等待数据
Waiting for fresh quotes	等待新鲜报价
Waiting for valid prices	等待有效价格
Waiting for live quote	等待实时报价
Time unavailable	时间不可用
Time unknown	时间未知
Quote time	报价时间
Quote age	报价年龄
Quote timestamp	报价时间戳
Source timestamp	来源时间戳
Last update	最近更新
Last scan	最近扫描
Last live update	最近实时更新
Close date:	收盘日期：
Close anchor date	收盘基准日期
Details	详情
Overview	概览
History	历史
Open spread history	开盘价差历史
Historical mode pauses live updates	历史模式暂停实时更新
History · paused	历史 · 已暂停
Live quote retrying	正在重试实时报价
Cash book closed / stale	现货盘口休市 / 已过期
Refresh now	立即刷新
Refresh	刷新
Auto refresh	自动刷新
Reset	重置
Apply	应用
Save	保存
Cancel	取消
Confirm	确认
Close details	关闭详情
Close earnings details	关闭财报详情
Dismiss	关闭提醒
Dismiss trigger broadcast	关闭触发广播
Remove	移除
Delete	删除
Add pair	添加交易对
Add	添加
Explore	查看
Search contracts	搜索合约
Search pair or company…	搜索交易对或公司…
All markets	所有市场
All events	所有事件
All	全部
Group by	分组方式
Market	市场
Contract	合约
Company	公司
Name	名称
Status	状态
Source	来源
Data sources	数据来源
Method	方法
Model	模型
Input	输入
Output	输出
Manual	手动
Automatic	自动
Default	默认
Selected	已选
Select	选择
Selected period	所选时段
Daily	每日
Hourly	每小时
Annualized	年化
Simple annualized	简单年化
Days	天
Hours	小时
Minutes	分钟
Seconds	秒
Observations	次观测
Sample	样本
Mean	均值
Median	中位数
Maximum	最大值
Minimum	最小值
Flat	持平
Actual	实际
Predicted	预测
Theoretical	理论
Observed	已观测
Implied	隐含
Retained	已保留
Frozen	已冻结
Missing	缺失
Incomplete	不完整
Expired data excluded	已剔除过期数据
Gross	毛值
Fees	费用
Borrow	借贷
Tax	税费
Latency	延迟
Leverage	杠杆
Profit	利润
Loss	亏损
Return	收益率
Returns	收益率
Yield	收益率
Open interest	未平仓量
Total	合计
Neutral	中性
Positive	正向
Negative	负向
High quality	高质量
Top tier	最高等级
Selective	精选
Tactical	战术
Tag	标签
Top	最高
Direction	方向
Basis	基差
Live price	实时价格
Oracle drift	预言机偏离
Anchor drift	基准偏离
Quote	报价
Book	盘口
Order book	订单簿
Liquidity	流动性
Settlement	结算
Net position	净持仓
Net positions	净持仓
Position	持仓
Positions	持仓
Dividend Calendar	股息日历
Dividends	股息
Dividend	股息
Earnings	财报
Confirmed	已确认
Estimated	预计
Ex-dividend date	除息日
Payment date	派息日
Record date	登记日
Issuer record date	发行人登记日
Dividend treatment	股息处理规则
Dividend events	股息事件
Earnings events	财报事件
Event detail	事件详情
Estimated adjustment	预计调整金额
Adjustment time	调整时间
Adjustment amount	调整金额
Announcement	公告
Not announced	尚未公布
Time not announced	时间尚未公布
Before U.S. open	美股开盘前
After U.S. close	美股收盘后
Date only	仅日期
Local date	当地日期
Official schedule	官方日程
Corporate actions	公司行动
Binance + Bitget TradFi corporate actions	Binance 与 Bitget 传统金融公司行动
Dividends and US / Japan / Korea earnings · official schedules and estimates clearly separated	股息及美国、日本、韩国财报，明确区分官方日程与预估
Monthly ex-dividend view + earnings + issuer record dates	月度除息日历、财报及发行人登记日
US · Japan · Korea / one row per company event	美国 · 日本 · 韩国 / 每项公司事件一行
Previous	上一个
Next	下一个
Monday	星期一
Tuesday	星期二
Wednesday	星期三
Thursday	星期四
Friday	星期五
Saturday	星期六
Sunday	星期日
Mon	周一
Tue	周二
Wed	周三
Thu	周四
Fri	周五
Sat	周六
Sun	周日
January	一月
February	二月
March	三月
April	四月
May	五月
June	六月
July	七月
August	八月
September	九月
October	十月
November	十一月
December	十二月
JLP market price & pool NAV	JLP 市场价格与池净值
Pool NAV	资金池净值
Discount / premium	折价 / 溢价
JLP fee yield & borrowing cost	JLP 费用收益与借贷成本
Borrow APR	借款年化利率
Borrowing cost	借贷成本
Borrowing drag	借贷成本拖累
Fee yield	费用收益
Hedge funding	对冲资金费率
Market price / pool NAV − 1. Paused when quotes are stale.	市场价 / 资金池净值 − 1；报价过期时暂停计算。
Price and premium history begins at local deployment.	价格及溢价历史自本地部署时开始记录。
Theoretical BTC / ETH / SOL hedges	BTC / ETH / SOL 理论对冲
Hedge / NAV	对冲金额 / 净值
Spot weight	现货权重
Units / JLP	每份 JLP 对冲数量
Position at selected L	所选杠杆下的持仓
Total hedge / JLP NAV	总对冲金额 / JLP 净值
Positive units mean a short; negative units mean a long. Ratios reflect pool assets and trader positions. Rebalance as delta changes.	正数量表示做空，负数量表示做多。比例反映资金池资产及交易者持仓；Delta 变化时需重新平衡。
Leveraged neutral carry	杠杆中性套利收益
Leveraged neutral carry history	杠杆中性套利历史
Use JLP position snapshot	使用 JLP 持仓快照
Posley MCP snapshot	Posley MCP 持仓快照
Posley MCP auto-sync	Posley MCP 自动同步
Position sync delayed	持仓同步延迟
Waiting for position sync	等待持仓同步
USDC borrowed	借入 USDC
Modeled HL hedge	按 HL 对冲模型估算
Last estimate	上次估算
Market data delayed	行情延迟
Waiting for fresh, aligned strategy inputs	等待各项行情同步更新
Carry estimates pause when a source is stale.	行情过期时暂停更新收益估算。
Waiting for position valuation	等待持仓估值
Position equity and leverage must be within the supported range.	持仓权益和杠杆须在支持范围内。
Loading chart history…	正在加载图表历史…
History could not be loaded · retrying	历史记录加载失败，正在重试
APR / total capital	年化收益 / 总资本
JLP leverage	JLP 杠杆
HL hedge leverage	HL 对冲杠杆
Total capital (USD)	总资本（USD）
Annualized theoretical carry on total capital	总资本的理论年化套利收益
JLP fee yield contribution	JLP 费用收益贡献
Hedge funding contribution	对冲资金费贡献
Borrowing cost contribution	借贷成本贡献
JLP equity / HL margin	JLP 权益 / HL 保证金
JLP value / borrowed USDC	JLP 价值 / 借入 USDC
1× JLP leverage uses no debt. All exposure is hedged. Return includes HL hedge margin in total capital; fees and residual PnL are excluded.	1 倍 JLP 杠杆不使用借款，所有敞口均对冲。总资本包含 HL 对冲保证金；收益未计入手续费和残余损益。
Net theoretical carry	净理论套利收益
Neutral carry chart range	中性套利图表时间范围
Neutral carry chart unit	中性套利图表单位
Last hour	最近一小时
24 hours	24 小时
7 days	7 天
30 days	30 天
90 days	90 天
Daily carry (USD)	每日套利收益（USD）
Historical 7-day fee APR	历史七天费用年化收益率
Official APR, locally recorded	本地记录的官方年化收益率
Hourly %	每小时 %
Simple annualized %	简单年化 %
Theoretical hedge ratio history	理论对冲比例历史
Funding unit	资金费率单位
History shows hourly settled funding; cards show current rates. Annualized = hourly rate × 24 × 365.	历史显示每小时已结算资金费，卡片显示当前费率；年化 = 每小时费率 × 24 × 365。
Net custody delta recorded once per minute. Historical data starts when hedge tracking was enabled.	每分钟记录托管资产净 Delta；历史从启用对冲追踪时开始。
Jupiter Perps activity	Jupiter 永续交易活动
JLP-backed BTC / ETH / SOL markets · live snapshots stored once per minute	由 JLP 支撑的 BTC / ETH / SOL 市场，每分钟保存实时快照
Trading activity & open interest	交易活动与未平仓量
Trailing 24h volume	滚动 24 小时成交量
Gross trader OI (long + short)	交易者未平仓总量（多头 + 空头）
One-sided OI reference (gross / 2)	单边未平仓参考值（总量 / 2）
Long share of gross OI	多头占未平仓总量比例
Volume 24h	24 小时成交量
Long OI	多头未平仓量
Short OI	空头未平仓量
Jupiter Perps liquidations	Jupiter 永续强平
Observed liquidation events · last 24h	最近 24 小时观测到的强平事件
Position notional liquidated	强平持仓名义金额
Long / short notional	多头 / 空头名义金额
Liquidation fees	强平费用
Waiting for the chain-event feed.	等待链上事件数据。
Liquidation event feed	强平事件流
Liquidation market	强平市场
Liquidated position side	被强平持仓方向
Long + short	多头及空头
Long liquidations	多头强平
Short liquidations	空头强平
Export events	导出事件
Time (HKT)	时间（HKT）
Liquidated side	被强平方向
Position notional	持仓名义金额
Execution price	成交价格
Liquidation fee	强平费用
Transaction	交易
Connecting to Jupiter chain events…	正在连接 Jupiter 链上事件…
Observed liquidation notional	观测强平名义金额
Cumulative USD · last 24h	最近 24 小时累计 USD
Trailing 24h volume history	滚动 24 小时成交量历史
USD millions	百万美元
Open interest history	未平仓量历史
Recent activity research	最近交易活动研究
Read the analysis and hedge implications	查看分析及对冲影响
All lines hidden	所有曲线已隐藏
Select a legend item below to show a line.	点击下方图例显示曲线。
No records in this range	此时段没有记录
Waiting for collection / backfill	等待采集 / 回填
History could not be loaded	无法加载历史
90-day history backfilled	90 天历史已回填
Partial history backfill failed; automatic retry	部分历史回填失败，正在自动重试
History backfill in progress	正在回填历史
Data feeds connected	行情源已连接
Some feeds pending / delayed	部分行情源等待中 / 延迟
Update failed · last record retained	更新失败，保留最近记录
Stale data	数据已过期
Premium calculation paused	溢价计算已暂停
Annualized theoretical carry	理论年化套利收益
Feed unavailable	行情源不可用
Coverage is incomplete	数据覆盖不完整
Top of book	最优盘口
Distribution	分布
Calibration	校准
Confidence interval	置信区间
Current theoretical fair price	当前理论合理价格
Theoretical move	理论涨跌幅
Fair value	合理价值
Market vs fair	市场价相对合理价
Live mode	实时模式
Backtest start	回测开始
Backtest end	回测结束
Update prediction	更新预测
Compare cash and perpetual pricing	比较现货与永续定价
Price source	价格来源
All relative-value pairs	所有相对价值交易对
Hedge shares	对冲股数
Hedge amount	对冲金额
ETF shares	ETF 股数
Daily reset	每日重置
Model only	仅模型
No execution	不执行交易
Live relationships	实时关联
Selected relationship	所选关联
Relationship	关联
Relationships	关联组合
Locked beta	锁定 Beta
Beta locked	Beta 已锁定
Prediction	预测
News	新闻
Related news	相关新闻
Live news unavailable.	实时新闻不可用。
No matching news	没有匹配新闻
Sources	来源
Recent	最近
Time range	时间范围
From	从
Until	截至
Start	开始
End	结束
Apply range	应用时段
Reset range	重置时段
Expand	展开
Collapse	折叠
Filter	筛选
Filters	筛选
Sort	排序
Ranking	排名
Session expired. Reload and sign in to this site.	登录已过期，请重新加载并登录本网站。
Connect Posley	连接 Posley
Reconnect Posley	重新连接 Posley
Connect	连接
Disconnect	断开连接
Sign out	退出登录
Sign in	登录
Office relay	办公室中继
Feed warning	行情警告
Data quality	数据质量
Original timestamp	原始时间戳
Estimated price	估计价格
Live estimate	实时估计
Cash close	现货收盘价
Latest close	最近收盘价
Regular close	常规收盘价
Previous close	前收盘价
Previous trading day	前一交易日
Reference date	参考日期
Benchmark	比较基准
Benchmark return	基准涨跌幅
Stock return	股票涨跌幅
Perp return	永续涨跌幅
Implied return	隐含涨跌幅
No observed return	暂无实际涨跌幅
Unknown	未知
Available	可用
Not available	不可用
Normal	正常
Warning	警告
Error	错误
Retry	重试
Waiting for quote	等待报价
Waiting for fresh cash/FX	等待新鲜现货 / 汇率报价
As of	截至
Now	当前
Ago	前
more	更多
through	截至
vs prior close	相对昨收
vs latest close	相对最近收盘
prior close	昨收
latest confirmed cash close	最近已确认现货收盘价
regular session	常规交易时段
extended hours	延长交易时段
last trade	最新成交
last cash	最近现货
not executable	不可视为可成交报价
not an executable	不属于可成交
before fees	未扣费用
before funding	未扣资金费
not live	非实时
live inputs	实时输入
no debt	无借款
history chart	历史图表
Asset	资产
Hide	隐藏
Show	显示
Time	时间
Date	日期
Range	范围
Data	数据
Chart	图表
Contracts	合约
Names	只标的
Comparison	对比
Comparisons	对比
Conversion	换算
Change	涨跌幅
Liquidity risk	流动性风险
Indicative only	仅供参考
Read only	只读
Futu quote missing	缺少富途报价
Funding history unavailable.	资金费率历史不可用。
Auction quotes unavailable.	竞价报价不可用。
Night basis history is unavailable.	夜盘基差历史不可用。
Dividend calendar unavailable	股息日历不可用
Live TSE cash	日本现货实时行情
Cash estimate	现货估计
Contract price	合约价格
Source price	来源价格
Source time	来源时间
Close reference	收盘参考
Validation	验证
Implied USD price	隐含美元价格
Implied JPY price	隐含日元价格
Converted price	换算价格
Current cash	当前现货
Predicted cash	预测现货
Price vs close	价格相对收盘
Return vs close	相对收盘涨跌幅
Dividend adjustment	股息调整
Estimated dividend	预计股息
Estimated earnings	预计财报
Official	官方
View rules	查看规则
View source	查看来源
View details	查看详情
Details unavailable	详情不可用
Trigger broadcast	触发广播
Positive oracle trigger	正向预言机偏离触发
Negative oracle trigger	负向预言机偏离触发
Ratio checked	比例已核实
Top size	最优档数量
Cash · USD equiv	现货 · 美元等值
No match	未匹配
Matched	已匹配
Direct	直接
Reference only	仅参考
Comparison unavailable	比较不可用
Signal ready	信号就绪
Trade	交易
Execution	执行
Not trading P&L.	并非交易损益。
Execution report	执行报告
Simulation	模拟
Paper trade	模拟交易
Estimated fees	预计费用
Total notional	总名义金额
Notional	名义金额
Margin	保证金
Balance	余额
Account	账户
Capital	资本
Risk	风险
Rebalance	再平衡
Rebalancing	再平衡
Refresh interval	刷新间隔
Historical	历史
Realtime	实时
Live quote edges	实时价差机会
Stock	股票
Stocks	股票
Hedge	对冲
Hedges	对冲
Market data	行情数据
Feed	数据源
Feeds	数据源
Input unavailable	输入不可用
Session	交易时段
cash / trial	现货 / 试撮价
trial	试撮
book closed	盘口休市
aligned	已对齐
unverified	未核实
verified	已核实
latency	延迟
reference days	个参考日
reference trading dates	个参考交易日
valid observations	个有效样本
valid n per stock below	各股票有效样本数见下方
retained observations are indicative	保留观测值仅供参考
previous traded Taiwan date	前一台湾实际交易日
following	跟随
locked	已锁定
signal	信号
current quote	当前报价
live update	实时更新
quote retrying	正在重试报价
close anchor	收盘基准
historical study	历史统计
live comparison	实时比较
fresh perp BBO	新鲜永续最优报价
perp vs last cash trade	永续对比现货最新成交
perp vs cash BBO mid	永续对比现货最优买卖中间价
last cash quote	最近现货报价
no live basis	无实时基差
stale / reference inputs	过期 / 参考输入
waiting for BBO	等待最优买卖报价
opposite ETF side	相反 ETF 方向
theoretical share-equivalent	理论等值股数
not a rounded order size	并非取整后的下单数量
funding cap	资金费上限
funding floor	资金费下限
cash snapshot	现货快照
price cap	价格上限
price floor	价格下限
Positive percentages are gross quoted differences, not guaranteed arbitrage. Japanese U.S. ADR comparisons use verified share ratios and do not need USD/JPY; TSE comparisons do. Taiwan cash/FX comparison and latest cash-close returns are separate indicative views; Taiwan is excluded from the live quote radar. Pre-market, closed and stale books are INDICATIVE. The KRX stream is not verified as NXT-routable. Confirm venue, fees, funding, borrow, tax and latency before trading.	正百分比表示报价毛差，不保证套利。日本股票的美国 ADR 比较使用已核实的股数比例，无需 USD/JPY；日本现货比较则需要。台湾现货 / 汇率比较及最近收盘涨跌幅是独立的参考视图，不纳入实时价差雷达。盘前、休市和过期盘口均仅供参考；KRX 数据流尚未核实可经 NXT 成交。交易前请确认场所、费用、资金费、借券、税费及延迟。
No live KRX cash quote for these names. The KRW amount is a converted Bitget contract-unit price, not a cash-stock quote or basis signal.	这些标的暂无韩国现货实时报价。韩元金额由 Bitget 合约单位价格换算，并非现货股票报价或基差信号。
Converted per Bitget contract unit; contract-to-share ratios are not verified. A daily FX reference is indicative and not an executable FX quote. No cash/perp spread is calculated.	按 Bitget 合约单位换算，合约与股票比例尚未核实。每日汇率参考值不可视为可成交外汇报价，此处不计算现货 / 永续价差。
Uses the latest completed regular session: today’s confirmed close after 15:30 KST / 14:30 HKT; the preceding session before then. After-hours trades never reset the close.	使用最近已完成常规交易日：韩国时间 15:30 / 香港时间 14:30 后使用今日已确认收盘价，此前使用前一交易日收盘。盘后交易不会重置收盘基准。
KRW/share = perp USDT × USD/KRW ÷ shares per contract; change = (implied KRW ÷ latest confirmed cash close − 1) × 100%. Uses the existing contract/share mapping and 1 USDT ≈ 1 USD. FX midpoint / last or daily reference is not an executable FX quote. Missing inputs remain blank; retained closes keep their actual date, including holidays and delayed publication. This panel does not change the cash/perp signals above.	韩元 / 股 = 永续 USDT 价格 × USD/KRW ÷ 每份合约股数；涨跌幅 =（隐含韩元价 ÷ 最近已确认现货收盘价 − 1）× 100%。沿用现有合约股数映射及 1 USDT ≈ 1 USD 假设。汇率中间价、最新值或每日参考不是可成交外汇报价。缺失输入留空；保留收盘价维持真实日期，包含假期或延迟公布。此板块不改变上方现货 / 永续信号。
Bitget bid / ask converted to NT$ per share. After the 13:30 HKT cash close, uses today’s confirmed regular-session close; before then, uses the preceding session. No oracle or ADR model.	将 Bitget 买卖价换算为每股新台币。香港时间 13:30 现货收盘后使用当天已确认常规收盘价，此前使用前一交易日；不使用预言机或 ADR 模型。
NT$/share = perp USDT × USD/TWD; change = (implied NT$ ÷ latest confirmed cash close − 1) × 100%. Assumes USDT = USD and one Taiwan share per quoted perp unit; contract multiplier is not independently verified. FX is indicative, not executable BBO. Missing closes remain blank; retained closes keep their actual date and are not relabeled as today. TWD prices use two decimals; calculations retain full precision. Green starts at +0.5%.	新台币 / 股 = 永续 USDT 价格 × USD/TWD；涨跌幅 =（隐含新台币价 ÷ 最近已确认现货收盘价 − 1）× 100%。假设 USDT 等于 USD，每个永续报价单位对应一股台股；合约乘数未经独立核实。汇率仅供参考，不是可成交最优报价。缺失收盘价留空，保留值保持真实日期，不标作今日。台币显示两位小数，计算保留完整精度；+0.5% 起显示绿色。
HKT · indicative FX, not executable BBO. Display assumes USDT = USD and one Taiwan share per perp price unit (contract multiplier not independently verified). No oracle / ADR adjustment is used in this tab.	HKT · 汇率仅供参考，并非可成交最优报价。显示假设 USDT 等于 USD、每个永续报价单位对应一股台股，合约乘数未经独立核实。本标签不作预言机 / ADR 调整。
1 HNHPF GDR = 2 TWSE 2317 ordinary shares. Implied GDR bid / ask = HONHAIUSDT bid / ask × 2. Assumes 1 ordinary share per perp price unit (multiplier unverified) and USDT = USD. No FX conversion is needed between these USD prices. Last / stale references are indicative, not executable spreads.	1 份 HNHPF GDR 对应 2 股 TWSE 2317 普通股。隐含 GDR 买卖价 = HONHAIUSDT 买卖价 × 2。假设每个永续报价单位对应一股普通股，乘数未核实，且 USDT 等于 USD；美元报价之间无需汇率换算。最近值或过期参考仅供参考，不能视为可成交价差。
KRX share price, not a verified KRX cash quote. Stock exposure is displayed to three decimals without whole-share rounding and may not be directly executable. For a long ETF hedged with a short USD-priced stock proxy, the model FX leg is short USD/KRW (sell USD / buy KRW); reverse both sides for a short ETF. HKD/USD is fixed at 7.84. CSOP may set the actual daily factor below 2×;	韩国股票每股价格，并非已核实的韩国现货报价。股票敞口显示三位小数，不取整，可能无法直接成交。持有 ETF 多头并做空美元计价股票代理时，模型外汇腿为做空 USD/KRW（卖美元 / 买韩元）；ETF 空头则两腿反向。HKD/USD 固定为 7.84，南方东英可能将实际每日杠杆设在 2 倍以下；
All models, including fixed-beta products, support up to 7D using five-minute candles; shorter windows retain one-minute precision. A supplied beta always runs directly; longer ranges show daily-reset and compounding drift rather than refitting it.	所有模型（含固定 Beta 产品）均支持最长 7 天，使用五分钟 K 线；较短窗口保留一分钟精度。给定的 Beta 始终直接使用，较长区间展示每日重置与复利偏离，而不重新拟合。
× is an assumption until checked against CSOP's daily target; fair value is conditional on the anchor, not an independent valuation.	倍杠杆在核对南方东英每日目标前仅为假设；合理价取决于所选基准，并非独立估值。
Only the relative FX move enters the theoretical product price; the absolute exchange-rate level does not.	理论产品价格仅纳入汇率相对变动，不纳入汇率绝对水平。
Research analytics only. A theoretical return is a model estimate, not a guaranteed trade or proof of arbitrage. Leveraged and inverse ETFs pursue daily objectives and can diverge materially over longer periods.	仅供研究分析。理论收益是模型估计，不保证交易结果，也不是套利证明。杠杆及反向 ETF 追踪每日目标，较长时段可能产生明显偏离。
EWY U.S. intraday + live SMH return → next KRX opening gap and historical probabilities.	EWY 美股日内涨跌幅与实时 SMH 涨跌幅 → 下次韩国开盘涨跌幅及历史概率。
Probabilities use BOTH signals: fixed 3 × 3 joint groups, not the SMH-only distribution. These are historical frequencies, not a calibrated live probability model.	概率同时使用两个信号，以固定 3 × 3 联合分组计算，而非单独使用 SMH 分布。这些是历史频率，不是经过校准的实时概率模型。
Left endpoints included, right endpoints excluded. The main probability card uses the joint table above.	分组包含左端点、不包含右端点；主要概率卡片使用上方联合分组。
One calendar year before the target opening, at least 60 observations. Raw SMH price returns match the live current-price / regular-close definition.	使用目标开盘前一年、至少 60 个样本。SMH 原始价格涨跌幅采用与实时输入一致的当前价格 / 常规收盘价口径。
before the associated U.S. session, the early estimate explicitly assumes a 0% intraday move. During the session, its actual ETF midpoint is divided by that session’s reported regular opening price. Until the opening anchor is confirmed, no live two-factor forecast is produced. After the session, the confirmed regular close-to-open return is fixed; later EWY after-hours moves are not inserted into the intraday factor.	对应美股时段开始前，早期估计明确假设日内涨跌幅为 0%。交易时使用实际 ETF 中间价除以该时段已公布常规开盘价；开盘基准确认前不生成实时双因子预测。交易结束后固定已确认的常规收盘相对开盘涨跌幅，不将后续 EWY 盘后变动加入日内因子。
live actual ETF midpoint relative to the regular close preceding the target U.S. session; this denominator stays fixed through that session’s close and after-hours. No ETF perpetual substitute is used. Quote ages retain their original times.	使用实际 ETF 实时中间价相对目标美股时段前的常规收盘价，分母在该时段收盘及盘后保持不变。不用 ETF 永续替代，报价时间保持原始值。
historical joint groups use the same two inputs with preselected boundaries −1% and +1%. Counts include flat opens; Wilson intervals indicate sampling uncertainty. Sparse or empty groups are never replaced by a different unlabelled cohort.	历史联合分组使用相同两个输入及预先设定的 −1%、+1% 边界。样本包含平开日，Wilson 区间反映抽样不确定性；稀疏或空分组不会被未注明的其他样本组替代。
completed U.S. session inputs only. The displayed backtest does not establish the same accuracy for pre-open assumptions or intraday quotes. No target-day opening is used to train that day’s prediction.	仅使用已结束美股时段输入。所示回测不能证明盘前假设或日内报价也有相同准确率；不会用目标当天开盘价训练当天预测。
official KRX cash opening of 034020.KS relative to the previous KRX cash close, not a Nextrade opening or perpetual mark. Standard KRX open is 09:00 KST / 08:00 HKT; special sessions are reflected in the displayed target time. Zero or multiple U.S. sessions during Korean holidays suspend the automatic forecast.	使用 034020.KS 官方韩国现货开盘价相对前收盘价，不使用 Nextrade 开盘价或永续标记价。KRX 正常开盘为韩国时间 09:00 / 香港时间 08:00，特殊交易时段体现在所示目标时间；韩国假期中对应零个或多个美股时段时，暂停自动预测。
Regular EWY opening/closing anchors are checked more often when needed. Calendars cover 2026–2027 using	必要时更频繁核对 EWY 常规开盘 / 收盘基准。交易日历覆盖 2026–2027 年，依据
Historical frequencies for BOTH inputs; not a calibrated live probability model. Fixed 3 × 3 groups: SMH ±1%,	两个输入的历史联合频率，并非经过校准的实时概率模型。固定 3 × 3 分组：SMH ±1%，
Left endpoints included, right endpoints excluded. Main probabilities use the joint cohorts above.	分组包含左端点、不包含右端点；主要概率使用上方联合样本组。
before the target U.S. session, its intraday move is explicitly assumed 0%. During the session, actual stock BBO midpoint / that session’s reported opening price − 1. Until that opening is confirmed, no live two-factor forecast is produced. After the session, the confirmed regular open-to-close return is fixed; after-hours	目标美股时段开始前，明确假设日内变动为 0%。交易时使用实际股票最优买卖中间价 / 该时段已公布开盘价 − 1；开盘价确认前不生成实时双因子预测。收盘后固定常规开盘至收盘涨跌幅；盘后
actual ETF midpoint / the regular close preceding the target U.S. session − 1. That denominator stays fixed through the U.S. close and after-hours until the forecasted HK opening rolls. No perpetual substitute. Quotes retain their original market times.	实际 ETF 中间价 / 目标美股时段前常规收盘价 − 1。分母在美股收盘和盘后保持固定，直至预测港股开盘日切换。不使用永续替代，报价保留原始市场时间。
−2%/+2%. Counts include flat openings; Wilson 95% intervals indicate sampling uncertainty. Empty groups remain unavailable; sparse groups are not replaced by an unlabelled cohort.	−2% / +2%。样本包含平开日，Wilson 95% 区间反映抽样不确定性。空分组保持不可用，稀疏组不会由未注明的其他样本组替代。
forecasts using only prior observations. The backtest uses completed U.S. sessions; it does not establish equal accuracy for live intraday inputs or pre-open assumptions. Candidate selection used the same research period.	仅使用过去观测进行预测。回测使用已结束美股时段，不能证明实时日内输入或盘前假设具有相同准确率；候选变量选择使用了同一研究期。
The model excludes the IPO first day and windows containing zero or multiple U.S. sessions. HK opens at 09:30 HKT; calendar coverage 2026–2027. Implied opening price waits for the completed preceding HK close.	模型剔除上市首日及包含零个或多个美股时段的窗口。港股开盘为香港时间 09:30，日历覆盖 2026–2027 年；隐含开盘价须等待前一港股交易日收盘确认。
Anchored to each day’s cash close and updated with Kioxia stock quotes. The latest trading-day close carries over the weekend.	以每日现货收盘为基准，随铠侠股票报价更新；周末沿用最近交易日收盘基准。
The model uses cash-stock returns. Bitget quotes are for comparison only. Positive deviation means the contract is above the estimate.	模型使用现货股票涨跌幅，Bitget 报价仅作比较。正偏离表示合约价格高于估计值。
USD estimates are per ordinary share. Contract comparisons assume one share per quoted unit and 1 USDT ≈ 1 USD; contract multipliers have not been independently verified. Deviation is a model comparison. Stale inputs suppress it.	美元估值为每股普通股价格。合约比较假设每个报价单位对应一股、1 USDT ≈ 1 USD，合约乘数未经独立核实。偏离为模型比较，输入过期时不显示。
Resets to each stock’s cash closing price every trading day, without an intercept or cumulative drift. Divide the JPY estimate by the spot USD/JPY rate for USD.	每个交易日重置为各股现货收盘价，不含截距或累计漂移；将日元估值除以即期 USD/JPY 即得美元估值。
Beta is fitted through the origin using the latest 126 valid sessions of cash-stock close-to-close log returns. The correlation r is Pearson’s coefficient over the same window. Calibration through	Beta 使用最近 126 个有效交易日的现货收盘对数收益率进行过原点拟合；相关系数 r 为同一窗口的 Pearson 系数。校准截至
Walk-forward validation over the latest 60 sessions, fitting each day with at most 126 earlier sessions. MAE is the mean absolute difference between estimated and actual daily returns in percentage points. Improvement is relative to always predicting an unchanged stock price. These daily cash-return errors are not overnight or weekend confidence intervals. A weak relationship means |r| < 0.4 or no improvement in historical error.	最近 60 个交易日逐日向前验证，每天最多使用此前 126 日拟合。MAE 为预计与实际每日涨跌幅的平均绝对差，单位为百分点。改进幅度相对始终预测股价持平的基准。这些日度现货收益误差不是隔夜或周末的置信区间；弱关联指 |r| < 0.4 或未改善历史误差。
Anchors switch at 15:30 JST each trading day. Stocks with unpublished closes pause. The prior close carries over weekends, holidays and the next session until its close. Yahoo closing data may be delayed; split days wait for a new anchor.	每个交易日日本时间 15:30 切换基准；尚未公布收盘价的股票暂停。周末、假期及下个交易日收盘前沿用此前收盘。Yahoo 收盘数据可能延迟，拆股日等待新基准。
are explicitly marked and do not enable live deviation. Yahoo USD/JPY spot references can supplement missing FX. Original market timestamps are retained. Live inputs freeze after 90 seconds; delayed inputs freeze after 35 minutes. Missing cash quotes leave the closing reference. Contract prices never replace cash inputs. Historical source:	均明确标注，且不启用实时偏离。Yahoo USD/JPY 即期参考可补充缺失汇率，保留原始市场时间。实时输入 90 秒后冻结，延迟输入 35 分钟后冻结；现货缺失时保留收盘参考。合约价格不替代现货输入。历史来源：
Some cash histories failed to refresh. Dated caches are retained; missing new-session closes pause the affected estimates.	部分现货历史更新失败，保留注明日期的缓存；缺少新交易日收盘价时暂停对应估值。
These are historical group frequencies, not a calibrated live probability model. The regression uses completed SMH daily returns; intraday and overnight quotes are provisional inputs.	这是历史分组频率，不是经过校准的实时概率模型。回归使用完整 SMH 日收益率，日内及隔夜报价为暂定输入。
Left endpoints included, right endpoints excluded. Mean and median can differ because individual openings can be extreme.	分组包含左端点、不包含右端点；个别开盘可能极端，导致均值与中位数不同。
actual US.SMH ETF bid/ask midpoint from the Posley office Futu stream, relative to the regular close before the U.S. session associated with the target Hong Kong opening. The anchor is held through the U.S. close and its after-hours period. No perpetual or Yahoo delayed quote is substituted as live SMH.	实际 US.SMH ETF 最优买卖中间价来自 Posley 办公室富途数据流，相对目标港股开盘对应美股时段前的常规收盘价。基准在美股收盘及盘后保持不变；不用永续或 Yahoo 延迟报价替代实时 SMH。
estimates update before, during and after the U.S. session. The historical model was tested with completed daily SMH returns, so its displayed historical accuracy does not establish the same accuracy for an early intraday estimate. Multiple U.S. sessions across a Hong Kong holiday and missing calendar coverage suspend the automatic forecast.	估计在美股时段前、时段中及结束后更新。历史模型以完整每日 SMH 收益率测试，所示历史准确率不能证明早期日内估计也有相同准确率。港股假期间对应多个美股时段或交易日历缺失时，暂停自动预测。
Yahoo Finance daily OHLC; raw SMH price returns use the same current-price / previous-close definition as the live input. Latest observation	Yahoo Finance 日线 OHLC；SMH 原始价格涨跌幅使用与实时输入相同的当前价 / 前收盘价定义。最近观测
Record dates are shown separately from ex-dividend dates. A source with no verified exact date is a coverage gap, not a no-dividend announcement.	登记日与除息日分开显示。来源没有经核实的确切日期表示数据覆盖缺口，不等于宣布不派息。
Exact times are HKT. After-U.S.-close events appear on the next HKT day. When no time is published, the calendar retains the issuer’s local date — no midnight time is assumed. Click any earnings event for the source and original timezone.	确切时间以香港时间显示。美股收盘后事件列在下一香港日期；未公布时间时保留发行人当地日期，不假设为午夜。点击财报事件可查看来源及原时区。
No verified matching earnings dates in this view. Check coverage below; this does not mean no earnings are scheduled.	当前视图没有核实后的匹配财报日期。请查看下方覆盖范围，这不代表没有财报安排。
ETF distributions remain in the dividend calendar. ETFs do not have corporate quarterly earnings releases. STRC follows its issuer Strategy; ADR and ordinary-share contracts share the company’s financial reporting event.	ETF 分配仍显示于股息日历；ETF 没有公司季度财报。STRC 跟随发行人 Strategy；ADR 与普通股合约共用对应公司的财报事件。
Listings are scanned from both exchanges. Missing dates are disclosed, not guessed. JPX schedules are issuer-submitted; KIND times may be conference-call times, with results released earlier. Nasdaq dates remain estimated until verified against the company.	扫描两个交易所的上市合约，披露缺失日期而不猜测。JPX 日程由发行人提交；KIND 时间可能为电话会议时间，业绩可能更早公布。Nasdaq 日期在与公司核实前仍标为预计。
Coverage follows the live Binance TradFi and Bitget RWA perpetual listings. Stocks and ETFs are included; commodities, indices, FX and pre-IPO contracts only appear if they match a confirmed cash-dividend event. Contract multipliers and exchange rules can change the final settlement.	覆盖实时上市的 Binance TradFi 和 Bitget RWA 永续，包括股票及 ETF；商品、指数、外汇和上市前合约仅在匹配已确认现金派息事件时出现。合约乘数及交易所规则可能改变最终结算。
This is the company’s record date, not a confirmed ex-dividend date. The company announcement does not confirm perpetual-contract settlement. Amounts and payment dates appear only when published by the issuer.	这是公司的登记日，并非已确认除息日。公司公告不能确认永续合约如何结算；仅在发行人公布后显示金额及支付日期。
For U.S. equities, Binance normally switches to hourly funding, enters reduce-only mode at 19:30 ET, executes special funding after standard funding at 20:00 ET, and restores normal trading around 20:01 ET. The special dividend rate bypasses the normal funding cap.	对于美股，Binance 通常切换至每小时资金费，在美东时间 19:30 进入只减仓模式，20:00 常规资金费后执行特殊资金费，约 20:01 恢复正常交易。特殊股息费率不受常规资金费上限限制。
Bitget normally keeps contract trading active during dividend settlement. The credit or deduction appears as a funding fee; long and short positions under the same UID are netted first.	Bitget 通常在股息结算时维持合约交易。收取或扣除的金额列为资金费，同一 UID 的多空持仓先净额计算。
HK basis: Futu stock ↔ selected perp venue · ADR basis: US reference ↔ selected perp venue	港股基差：富途股票 ↔ 所选永续场所；ADR 基差：美股参考 ↔ 所选永续场所
Raw basis excludes fees, funding, FX execution cost, ADR fees and lot-size rounding. HK stocks, LITE and NVDA are read through Futu OpenD; OTC ADRs are read through the Posley office relay. NVDA and LITE are directional context only.	原始基差未扣手续费、资金费、汇率成交成本、ADR 费用及手数取整。港股、LITE、NVDA 来自富途 OpenD，OTC ADR 来自 Posley 办公室中继；NVDA、LITE 仅提供方向参考。
Compare truly executable prices with Oracle: sellable premiums use best bid, buyable discounts use best ask, and markets that straddle Oracle are neutral. Trigger broadcasts fire on threshold crossings.	将实际可成交价格与预言机比较：可卖出溢价使用最优买价，可买入折价使用最优卖价，买卖价跨越预言机时为中性。跨越阈值时触发广播提醒。
Pairs are saved on this device. Add Binance symbols or Hyperliquid DEX:SYMBOL contracts such as mkts, para and xyz to the live monitor.	交易对保存在本机。可将 Binance 代码或 Hyperliquid 的 DEX:SYMBOL 合约（例如 mkts、para、xyz）加入实时监控。
Executable deviation uses best bid only when it can be sold above Oracle, and best ask only when it can be bought below Oracle. If Oracle sits inside the spread, the executable edge is zero. Funding is shown in each venue's native interval.	可成交偏离仅在最优买价高于预言机时采用买价、最优卖价低于预言机时采用卖价。预言机落在买卖价差内时，可成交优势为零。资金费按各场所原始结算间隔显示。
One screen for Polymarket, Hyperliquid and Binance. Every matched route shows normalized hourly funding spread, live price spread and the carry direction.	在同一屏幕比较 Polymarket、Hyperliquid 和 Binance。各匹配路径显示统一为每小时的资金费差、实时价格差及套利方向。
Funding spread = Polymarket hourly rate − comparison venue hourly rate. Binance native funding is divided by its current settlement interval; Hyperliquid and Polymarket settle hourly. Price spread = Polymarket midpoint ÷ comparison midpoint − 1. Reference mappings can differ in session, collateral and index methodology.	资金费差 = Polymarket 每小时费率 − 对比场所每小时费率。Binance 原始资金费按当前结算间隔折算，Hyperliquid 与 Polymarket 每小时结算。价格差 = Polymarket 中间价 ÷ 对比中间价 − 1。参考映射的交易时段、抵押品和指数方法可能不同。
Selected JLP and HL leverages applied to contemporaneous fee, hedge funding, margin-notional and borrow snapshots. Stored once per minute. Not a cumulative realized-PnL backtest.	将所选 JLP、HL 杠杆应用于同期费用、对冲资金费、保证金名义金额及借款快照，每分钟存储一次，并非累计已实现损益回测。
OpenJUP uses a rolling 7-day fee APR. Borrow rates start at deployment. Historical and official JLP yields may use different methodologies.	OpenJUP 使用滚动七天费用年化收益率，借款利率从部署时开始记录。历史与官方 JLP 收益率的方法可能不同。
* Long OI ≈ locked tokens × current Jupiter quote; short OI = global short size. Different valuation conventions apply to the two sides. The one-sided reference is not an exact replication of DeFiLlama's event-based OI.	* 多头未平仓量 ≈ 锁定代币 × 当前 Jupiter 报价；空头未平仓量 = 全局空头规模。两侧估值口径不同，单边参考值不完全等同于 DeFiLlama 基于事件的未平仓量。
A confirmed liquidation calls for refreshing hedge targets. The actual quantity drift and residual exposure determine whether rebalancing is needed.	确认强平后应刷新对冲目标，再依据实际数量偏移和残余敞口决定是否需要再平衡。
New events appear here with an in-panel alert. Records are stored on this instance; a Render redeploy can reset coverage without persistent storage. Unavailable amounts remain blank; outages are never displayed as zero liquidations.	新事件在此显示并在板块内提醒。记录存储于本实例；没有持久存储时 Render 重新部署可能重置覆盖范围。缺失金额留空，故障不会显示为零强平。
Long and short position notional accumulated in one-minute buckets over the monitored portion of this window. Collection begins at the timestamp shown above; earlier history is not backfilled.	按一分钟时间桶累计此窗口已监控区间内的多空持仓名义金额。采集从上方时间开始，更早历史不回填。
Overlapping rolling-24h snapshots; never sum these points. History starts when activity tracking was enabled.	相互重叠的滚动 24 小时快照，不能将各点求和。历史从启用活动追踪时开始。
Long / short split, gross total and gross / 2 reference. History starts when activity tracking was enabled; no invented backfill.	多空拆分、总量及总量 / 2 参考。历史从启用活动追踪时开始，不虚构回填。
Volume periods are aggregates, not a daily time series. Liquidation fees cannot establish event counts or liquidated notional.	成交量时段为聚合值，并非逐日时间序列。强平费用无法确定事件次数或被强平名义金额。
Move, tap, or use left and right arrow keys to inspect exact values	移动、点击或使用左右方向键查看精确值
Live quote, oracle drift and funding	实时报价、预言机偏离与资金费率
Cash-stock estimates driven by Kioxia	以铠侠为因子的现货股票估值
Cash-anchored Japanese stock estimates	以现货为基准的日本股票估值
Awaiting closing anchors	等待收盘基准
Awaiting post-close cash quote	等待收盘后现货报价
Awaiting a post-close Kioxia stock quote	等待收盘后的铠侠股票报价
Awaiting spot FX quote	等待即期汇率报价
Awaiting valid quotes	等待有效报价
Live cash input	实时现货输入
All cash closing prices confirmed	所有现货收盘价均已确认
Estimates pause where the new close is missing	缺少新收盘价的标的暂停估值
Loading cash closing prices	正在加载现货收盘价
Closing reference	收盘参考
Common close anchor	共同收盘基准
Japan · cash estimates	日本 · 现货估值
Japan cash market · Kioxia reference	日本现货市场 · 铠侠参考
Kioxia 285A · cash stock	铠侠 285A · 现货股票
Cash / perpetual monitor ↗	现货 / 永续监控 ↗
Close-based estimate · overnight unvalidated	收盘基准估计，隔夜有效性未经验证
11 Japanese stocks	11 只日本股票
Stock price estimates	股票价格估计
Stock / status	股票 / 状态
Historical daily error	历史每日误差
Midpoint deviation	中间价偏离
Contract vs estimate	合约价相对估计值
Vs close	相对收盘
β / correlation	β / 相关系数
Weak relationship	关联较弱
Cash-driven estimate	现货驱动估计
1-share basis · reference only	每股口径，仅供参考
JPY estimate ÷ USD/JPY = USD estimate	日元估计价 ÷ USD/JPY = 美元估计价
Refreshes every 2 seconds while visible	页面可见时每 2 秒刷新
Last estimate and original quote time retained	保留最近估计及原始报价时间
Loading cash closing anchors, stock models and quotes…	正在加载现货收盘基准、股票模型及报价…
Methodology, historical validation and update rules	方法、历史验证与更新规则
All quote times in HKT · JPY estimates use cash-market inputs	所有报价时间为香港时间，日元估值使用现货市场输入
Stock close × (Kioxia current price / Kioxia same-day close)	股票收盘价 ×（铠侠当前价 / 铠侠同日收盘价）
Posley Kioxia stock and USD/JPY FX quotes take priority. Kioxia can also use	优先采用 Posley 铠侠股票及 USD/JPY 汇率报价，铠侠也可使用
Japannext PTS cash trades	Japannext PTS 现货成交
Public Kabutan quotes have a	公开 Kabutan 报价存在
15-minute delay	15 分钟延迟
Daily cash-close anchors · Kioxia input · weekend carry	每日现货收盘基准 · 铠侠输入 · 周末沿用
Historical closes are split-adjusted; returns exclude dividend adjustments.	历史收盘价已调整拆股，收益率不含股息调整。
Connect Posley cash feed	连接 Posley 现货行情
Session expired. Reload this page and sign in again.	登录已过期，请重新加载页面并重新登录。
Data temporarily unavailable. The last estimate and original quote time are retained.	数据暂不可用，保留最近估计及原始报价时间。
Market data temporarily unavailable	行情数据暂不可用
Connection failed	连接失败
Awaiting	等待
Improvement	改进幅度
Estimate inputs and anchors	估值输入与基准
Estimate	估计
Estimates	估值
Correlation	相关系数
Closing	收盘
Monitor	监控
Index	指数
Korean	韩国
Japanese	日本
Taiwanese	台湾
Stock market	股票市场
Filter stock market	筛选股票市场
Server-side Posley ADR access is not configured.	尚未配置服务器端 Posley ADR 访问。
Waiting for cash quote	等待现货报价
Waiting for independent FX	等待独立汇率
Dividend ÷ underlying price	股息 ÷ 标的价格
Company dividend schedule	公司派息日程
No matching announced dividend events found. Coverage is not exhaustive.	未找到匹配的已公布派息事件，覆盖范围并非完整。
Schedules may change. An empty day is not confirmation of no event.	日程可能变化，日历为空不代表当天没有事件。
Earnings events do not imply a dividend or a perpetual-contract adjustment.	财报事件并不意味着派息或永续合约调整。
An empty date is not confirmation that no dividend is scheduled.	日期为空不代表没有派息安排。
Companies without an exact date in	没有确切日期的公司，位于
Company dividend sources	公司股息来源
Korean & Japanese company dividend sources	韩国及日本公司股息来源
Earnings coverage & data gaps	财报覆盖与数据缺口
Coverage: US	覆盖：美国
Built-in coverage	内置覆盖范围
Eligible contracts	符合条件的合约
Excluded funds / other markets	已剔除基金 / 其他市场
Stocks and ETFs included	包含股票及 ETF
Net open position at the settlement snapshot	结算快照时的净持仓
No special dividend settlement	没有特殊股息结算
Longs receive · shorts pay	多头收取，空头支付
Exchange rule ↗	交易所规则 ↗
Company announcement	公司公告
Check the issuer notice ↗	查看发行人公告 ↗
Not listed	未上市
No date found this month	本月未找到日期
Without a date this month	本月没有日期
Without a verified date this month	本月没有核实日期
Cash / trial vs Bitget	现货 / 试撮价对比 Bitget
ADR premium / discount to Binance-implied ADR	ADR 相对 Binance 隐含 ADR 的溢价 / 折价
ADR ticker · optional	ADR 代码，可选
HK shares per ADR	每份 ADR 对应港股股数
Futu stock	富途股票
Futu auction and US references versus Binance, Bybit, Bitget and MEXC perpetuals	富途竞价、美股参考与 Binance、Bybit、Bitget、MEXC 永续对比
HK stocks, LITE and NVDA use OpenD; eight OTC ADRs use the Posley office feed.	港股、LITE 及 NVDA 使用 OpenD，八只 OTC ADR 使用 Posley 办公室行情。
Absolute midpoint basis %	中间价基差绝对值 %
Executable auction basis	可成交竞价基差
Executable action	可成交方向
Executable top-level capacity	最优档可成交数量
Five-level book	五档盘口
Bid qty	买盘数量
Ask qty	卖盘数量
Bid/ask midpoint	买卖中间价
Independent feed health	独立行情源状态
Inside spread	位于买卖价差内
No aligned ADR and perp prices for this night.	本夜盘没有对齐的 ADR 与永续价格。
Overnight basis tape	隔夜基差记录
Night history unavailable	夜盘历史不可用
21:00–04:00 HKT · outside the window, the latest completed night stays on screen	香港时间 21:00–04:00；窗口外保留最近已完成夜盘
Current return vs reference close	当前相对参考收盘价涨跌幅
Directional context for Zhongji · not an executable basis	中际旭创方向参考，并非可成交基差
Directional semiconductor context for GIGADEV · not an executable basis	兆易创新半导体方向参考，并非可成交基差
Quote times	报价时间
Prices refresh automatically every 2 seconds	价格每 2 秒自动刷新
Snapshots refresh every five seconds	快照每 5 秒刷新
Cash refresh: 60s · fetched	现货每 60 秒刷新，获取于
Bitget public market data	Bitget 公开行情数据
Bitget quote:	Bitget 报价：
US references	美股参考
Unavailable in the latest push.	最近推送中不可用。
Quantities use provider units. Book timestamp:	数量采用数据提供方单位，盘口时间：
No additional device-local pairs.	没有额外的本机交易对。
Add an Oracle pair	添加预言机交易对
Add and analyze	添加并分析
Add mapping	添加映射
No executable Oracle edge	没有可成交预言机价差
No executable buy discount.	没有可成交买入折价。
No executable sell premium.	没有可成交卖出溢价。
No contract exceeds	没有合约超过
Positive alerts	正向提醒
Negative alerts	负向提醒
Largest absolute drift	最大绝对偏离
Largest drift	最大偏离
Oracle edge	预言机价差机会
Oracle trigger	预言机触发
5-second snapshots + WebSocket increments	5 秒快照及 WebSocket 增量更新
No news request until enabled	启用前不请求新闻
No relevant article was published in the last 48 hours.	最近 48 小时没有发布相关文章。
Keeping the current reading list while one or more live sources reconnect.	部分实时来源重连时保留当前阅读列表。
Searching only this pair…	仅搜索此交易对…
Cross-venue market pulse	跨市场动态
Cross-venue midpoint available	跨市场中间价可用
Market prices, not guaranteed convergence	市场价格，不保证收敛
Prediction error significance	预测偏差显著性
Watch at ±1.5σ · dislocation at ±2σ · suppressed when model quality is weak.	±1.5σ 提醒关注，±2σ 提醒错位；模型质量弱时不显示。
Cumulative percentage-point error from the selected anchor · ±2% broadcast threshold	相对所选基准的累计百分点误差，广播阈值 ±2%
FX conversion · separate from shares/contract	汇率换算，与每份合约股数分开处理
Both presets update from live midpoints every	两个预设均根据实时中间价更新，每
Ready-sized market-neutral legs	已计算数量的市场中性两腿
Reference beta · recommended for new contracts	参考 Beta，建议新合约使用
Assumed daily factor	假设每日杠杆系数
Choose an anchor	选择基准
Choose a past window to inspect	选择历史窗口查看
Every deviation uses this exact minute	所有偏离使用同一个精确分钟基准
No fresh matching coverage	没有新鲜的匹配数据
Only this pair changes; the rest of Relative Value Monitor stays as before.	仅此组合变化，相对价值监控的其他部分保持不变。
Choose a past window	选择历史时段
Back to live ↗	返回实时 ↗
View all	查看全部
View history	查看历史
Start live monitoring	开始实时监控
Live updates are paused until you return to live monitoring.	返回实时监控前，实时更新保持暂停。
Refresh delayed · keeping last chart	刷新延迟，保留上次图表
Restore	恢复
Lock	锁定
Formula type	公式类型
Perp symbol	永续代码
Perp venue	永续场所
Target symbol	目标代码
Target venue	目标场所
Predictor symbol	预测变量代码
Predictor venue	预测变量场所
Symbol	代码
Symbols	代码
Exchange	交易所
Venue	交易场所
Category	类别
All categories	所有类别
Market categories	市场类别
Unmapped contracts	未映射合约
Exchange-listed pairs	交易所上市交易对
Active Poly Perps	活跃 Poly 永续
Hourly-normalized Poly ↔ BN / HL	统一每小时口径的 Poly ↔ BN / HL
Funding-ready routes	资金费可比较路径
Price-ready routes	价格可比较路径
Largest funding spread	最大资金费差
Largest price spread	最大价格差
Poly funding / 1h	Poly 每小时资金费
Poly mid	Poly 中间价
Poly midpoint	Poly 中间价
Poly next	Poly 下次结算
Native	原始口径
No markets match the current filters.	没有符合当前筛选的市场。
Polymarket public funding history · hourly settlements	Polymarket 公开资金费历史，每小时结算
No settled funding observations are available in this window.	此窗口没有已结算资金费记录。
Loading funding settlements…	正在加载资金费结算…
Model, input timing & validation	模型、输入时间及验证
Two-factor opening distribution	双因子开盘分布
Joint opening distribution	联合开盘分布
EWY U.S. intraday	EWY 美股日内涨跌幅
U.S. intraday	美股日内涨跌幅
U.S. intraday + live SMH return → next HK opening gap and historical probabilities.	美股日内涨跌幅与实时 SMH 涨跌幅 → 下次港股开盘涨跌幅及历史概率。
Live SMH return → estimated next opening gap and historical probabilities.	实时 SMH 涨跌幅 → 预计下次开盘涨跌幅及历史概率。
How often did DOOSENER open higher?	DOOSENER 历史高开频率是多少？
How often did SMIC open higher?	中芯国际历史高开频率是多少？
Historical estimates · live inputs are provisional	历史估计，实时输入为暂定值
Historical trade candles and fresh bid/ask midpoints ↗	历史成交 K 线及新鲜买卖中间价 ↗
Enter a return between −30% and +30%.	请输入 −30% 至 +30% 之间的涨跌幅。
Explore an SMH move	查看 SMH 涨跌情景
Explore both ETF moves	查看两个 ETF 涨跌情景
Select a row to explore both inputs.	选择一行查看两个输入。
Select a row to explore both moves.	选择一行查看两项变动。
Select a row to try that group.	选择一行测试对应分组。
Observed opening gaps in this group.	本分组中观测到的开盘涨跌幅。
One calendar year of observations before the predicted opening; at least 60 required.	预测开盘前一年内的观测，至少需要 60 个样本。
No later SMIC opening is used to train that date’s backtest forecast.	不会使用后续中芯国际开盘价训练该日回测预测。
Holdout MAE	留出验证平均绝对误差
Holdout R²	留出验证 R²
Holdout correlation	留出验证相关系数
Joint 3 × 3 cohorts use both inputs with fixed boundaries SMH −1%/+1% and	3 × 3 联合分组同时使用两个输入，固定 SMH 边界 −1% / +1%，以及
Calendars:	交易日历：
KRX market rules	韩国交易所市场规则
Korean public-holiday dates	韩国公共假期日期
NYSE holidays	纽约证交所假期
JPX 2026–2027 trading calendar	JPX 2026–2027 交易日历
U.S. market holidays and early closes	美股假期及提前收盘
Unexpected exchange suspensions are not known in advance.	无法预先知道交易所突发停市安排。
Unexpected exchange closures require a calendar update.	交易所突发休市需要更新日历。
A-share history is not pooled.	不合并 A 股历史样本。
00981 opening price / previous HK close − 1	00981 开盘价 / 前一港股收盘价 − 1
034020 KRX opening price / previous KRX close − 1	034020 韩国开盘价 / 前一韩国收盘价 − 1
Opening price / previous HK close − 1	开盘价 / 前一港股收盘价 − 1
CSOP product reference	南方东英产品参考
Verify the daily leverage assumption ↗	核实每日杠杆假设 ↗
Model notional · reverse for short ETF	模型名义金额，ETF 空头则反向
USD/KRW change from the selected anchor	USD/KRW 相对所选基准变动
USD · fixed 1 USD = HK$7.84	USD · 固定 1 USD = HK$7.84
USDT equivalent	USDT 等值
Amount / stock price	金额 / 股票价格
Actual move	实际变动
Observed move	观测变动
Actual versus model	实际相对模型
Minus theoretical return	减去理论收益率
Aligned one-minute observations	已对齐的一分钟观测
Aligned points	已对齐数据点
Per share	每股
Underlying	标的
Pairs	交易对
Quote times in HKT	报价时间为香港时间
Live mids	实时中间价
Listed	已上市
Listing	上市
Fresh	新鲜
Checked	已核对
Resolution	分辨率
Intraday	日内
Treasury	美国国债
Triggered	已触发
Estimate:	估计：
Anchors:	基准：
Cash inputs:	现货输入：
Target:	目标：
Timing:	时间口径：
Two-factor model:	双因子模型：
Probabilities:	概率：
SMH timing:	SMH 时间口径：
EWY timing:	EWY 时间口径：
Outside	超出
Last	最近
Opening	开盘
And	及
Equivalent	等值
Quotes	报价
Stock / ETF candidates	股票 / ETF 候选标的
Stock / ETF	股票 / ETF
Before trading. Actual cash-stock settlement and product FX mechanics may differ.	交易前核实。实际现货交割及产品汇率机制可能不同。
Deviation alert board	偏离提醒看板
Set the anchor. Then watch the drift.	设置基准，监控偏离。
Three-venue carry & basis	三市场资金费套利及基差
Funding & Basis	资金费率及基差
HKEX pre-open / cross-venue basis	港交所盘前 / 跨市场基差
Ten-second relative value	每十秒更新的相对价值
The selected predictor explains the paired contract's move. Live midpoint, theoretical return and deviation refresh every 10 seconds; the historical curve remains aligned to one-minute candles.	使用所选预测变量解释配对合约涨跌幅。实时中间价、理论收益及偏离每 10 秒刷新，历史曲线保持与一分钟 K 线对齐。
The saved Posley login has expired. Connect Posley again.	保存的 Posley 登录已过期，请重新连接 Posley。
Korean, Japanese and Taiwanese stock cross-venue basis	韩国、日本及台湾股票跨市场基差
Korean perpetual KRW conversion table	韩国永续韩元换算表
Taiwan stock reference basis	台湾股票参考基差
Perp / perp basis	永续 / 永续基差
Benchmark input	基准输入
Trigger threshold	触发阈值
Initial anchor	初始基准
Trigger count	触发次数
Signal threshold	信号阈值
Positive oracle	正向预言机偏离
Negative oracle	负向预言机偏离
Executable	可成交
Stock price	股票价格
Current price	当前价格
Research	研究
Yield, hedging & financing monitor	收益、对冲与融资监控
Market overview	市场概览
Hedge & neutral carry	对冲与中性套利收益
First-order custody delta · point-in-time estimates	一阶托管资产 Delta · 时点估计
On-chain pool NAV	链上资金池净值
Premium / discount to NAV	相对净值溢价 / 折价
Official APY · trading fee yield	官方复合年化收益率 · 交易费用收益
Simple annualized APR	简单年化收益率
Pool AUM	资金池管理资产规模
JLP Loan borrow APR	JLP 抵押贷款年化利率
Borrow USDC against JLP · simple APR	以 JLP 抵押借入 USDC · 简单年化利率
USDC utilization	USDC 使用率
Available liquidity	可用流动性
Positive: longs pay shorts · Negative: shorts pay longs	正资金费率：多头支付空头；负资金费率：空头支付多头
Waiting for aligned inputs	等待对齐后的输入
Data sources & methodology	数据来源与方法
Price, NAV & hedge ratios	价格、净值与对冲比例
Yield, funding & history	收益、资金费率与历史
Jupiter pool data	Jupiter 资金池数据
Official custody fields	官方托管字段
Loan LTV	贷款抵押率
Limit	上限
Stored	已存储
Stored once per minute	每分钟存储一次
Price timestamp	价格时间
Slot	区块槽位
Timestamp	时间戳
Trading fee yield	交易费用收益
Financing	融资
Hedging	对冲
Carry	套利收益
Per year	每年
Per day	每日
Year	年
Day	日
Local	本地
Supplies a transaction-based USD reference price. Pool NAV and custody balances come from	提供基于成交的美元参考价。资金池净值及托管余额来自
Theoretical hedge ratios use net custody delta, including Jupiter traders' positions, rather than spot asset weights.	理论对冲比例使用托管资产净 Delta，包含 Jupiter 交易者持仓，而非仅按现货资产权重。
For asset i, Aᵢ = Gᵢ + (ownedᵢ − lockedᵢ)Pᵢ + Sᵢ(Pᵢ / P̄ᵢ − 1). Thus hedge units per JLP = [(ownedᵢ − lockedᵢ) + Sᵢ / P̄ᵢ] / JLP supply; NAV hedge ratio = (Aᵢ − Gᵢ + Sᵢ) / pool AUM. A is custody AUM, G is guaranteed USD and S is trader short size. See	对于资产 i，Aᵢ = Gᵢ + (ownedᵢ − lockedᵢ)Pᵢ + Sᵢ(Pᵢ / P̄ᵢ − 1)。因此每份 JLP 对冲数量 = [(ownedᵢ − lockedᵢ) + Sᵢ / P̄ᵢ] / JLP 供应量；净值对冲比例 = (Aᵢ − Gᵢ + Sᵢ) / 资金池 AUM。A 为托管 AUM，G 为保证美元金额，S 为交易者空头规模。参见
JLP equity E buys L × E of JLP at market price. Debt is (L − 1) × E, so 1× has no borrowing interest. All JLP exposure is hedged on Hyperliquid, including the first 1×. Negative funding reduces carry. HL margin M equals hedge notional / hedge leverage K. Total capital T = E + M; for a fixed T, E = T / (1 + L × H / K), where H is the total absolute HL mark-valued hedge notional per $1 of JLP.	JLP 权益 E 按市场价买入 L × E 的 JLP，借款为 (L − 1) × E，因此 1 倍杠杆没有借款利息。所有 JLP 敞口（含首个 1 倍）均在 Hyperliquid 对冲，负资金费会减少收益。HL 保证金 M = 对冲名义金额 / 对冲杠杆 K。总资本 T = E + M；给定 T 时 E = T / (1 + L × H / K)，H 为每 1 美元 JLP 对应、按 HL 标记价计算的对冲名义金额绝对值合计。
Net carry on JLP equity R = L × [JLP APR × NAV / market price + Σ(units per JLP × HL oracle / market price × funding APR)] − (L − 1) × borrow APR. Total-capital APR = R / (1 + L × H / K). Funding is valued at the	JLP 权益净套利收益 R = L × [JLP APR × NAV / 市场价 + Σ(每份 JLP 数量 × HL 预言机价 / 市场价 × 资金费 APR)] − (L − 1) × 借款 APR。总资本 APR = R / (1 + L × H / K)。资金费按以下价格估值：
This is simple annualized carry on JLP equity plus HL initial margin. Margin assumes leverage K on the short hedge and no extra reserve; actual requirements and liquidation buffers may differ.	这是以 JLP 权益加 HL 初始保证金为资本的简单年化套利收益。保证金假设空头对冲使用 K 倍杠杆、不额外留储备；实际要求及强平缓冲可能不同。
Assumes unchanged rates and continuous rebalancing. Excludes execution fees, slippage, price/NAV convergence, hedge basis changes, residual trader PnL and margin opportunity cost. It is a theoretical carry estimate, not realized PnL or a guarantee of neutrality.	假设费率不变且持续再平衡。未计入成交费用、滑点、价格与净值收敛、对冲基差变化、残余交易者损益和保证金机会成本。此为理论套利收益估计，不是已实现损益，也不保证中性。
Current JLP APR/APY follows Jupiter's published update cycle.	当前 JLP APR / APY 按 Jupiter 公布的周期更新。
Supplies completed daily observations of rolling 7-day fee APR; it remains separate from the official series. Borrow APR is from	提供滚动七天费用 APR 的已完成日度观测，与官方序列分开。借款 APR 来自
Supplies current and settled funding. Annualized funding = hourly rate × 8,760. Hedge and carry histories start when this feature was enabled; they use contemporaneous snapshots, never today's ratios applied to old rates. Local samples are written once per minute; live values refresh every 10–15s. Samples pause during sleep or shutdown. Times are HKT; CSV timestamps are UTC.	提供当前及已结算资金费率。年化资金费 = 每小时费率 × 8,760。对冲和套利历史从启用功能时开始，使用同期快照，不将今日比例套用到过去费率。本地样本每分钟保存一次，实时值每 10–15 秒刷新；休眠或关机时暂停采样。时间为香港时间，CSV 时间戳为 UTC。
Next Korea open · KRX	下次韩国开盘 · KRX
South Korea	韩国
Market neutral	市场中性
`;

export const TRANSLATION_ENTRIES: ReadonlyArray<readonly [string, string]> = catalog.trim().split("\n").map(line => {
  const separator = line.indexOf("\t");
  if (separator < 1) throw Error("Invalid interface translation entry");
  return [line.slice(0, separator), line.slice(separator + 1)] as const;
});
const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const dictionary = new Map(TRANSLATION_ENTRIES.map(([english, chinese]) => [normalize(english), chinese]));
// Index by first word, rather than compiling a giant regular expression on the
// browser's main thread. Long paragraphs use the constant-time exact lookup.
const prefixes = new Map<string, string[]>();
for (const key of dictionary.keys()) {
  if (key.length > 100) continue;
  const first = key.match(/^[a-z0-9_]+/)?.[0];
  if (!first) continue;
  const group = prefixes.get(first) ?? [];
  group.push(key); prefixes.set(first, group);
}
for (const group of prefixes.values()) group.sort((a, b) => b.length - a.length);
const wordPattern = /[A-Za-z0-9_]+/g;
function phraseEnd(text: string, start: number, phrase: string) {
  let i = start;
  for (const char of phrase) {
    if (char === " ") {
      if (!/\s/.test(text[i] ?? "")) return -1;
      while (i < text.length && /\s/.test(text[i])) i++;
    } else {
      if (text[i]?.toLowerCase() !== char) return -1;
      i++;
    }
  }
  return /[A-Za-z0-9_]/.test(text[i] ?? "") ? -1 : i;
}
function translatePhrases(text: string) {
  let result = "", previous = 0, match: RegExpExecArray | null;
  wordPattern.lastIndex = 0;
  while ((match = wordPattern.exec(text))) {
    const candidates = prefixes.get(match[0].toLowerCase());
    if (!candidates) continue;
    for (const phrase of candidates) {
      const end = phraseEnd(text, match.index, phrase);
      if (end < 0) continue;
      result += text.slice(previous, match.index) + dictionary.get(phrase);
      previous = end; wordPattern.lastIndex = end;
      break;
    }
  }
  return previous ? result + text.slice(previous) : text;
}
const cache = new Map<string, string>();
export const TRANSLATION_CACHE_LIMIT = 1024;

function translateDynamicText(text: string): string | null {
  let match = text.match(/^Following the (locked|latest pre-open) ADR (up|down) signal\.$/i);
  if (match) return `跟随${match[1].toLowerCase() === "locked" ? "已锁定" : "最新盘前"} ADR ${match[2].toLowerCase() === "up" ? "上涨" : "下跌"}信号。`;
  match = text.match(/^(.+?) executable best bid\/ask is ([+−-]?[\d.]+%) from oracle, outside the (±[\d.]+%) band(?: · (\d+) additional triggers?)?\.$/i);
  if (match) return `${match[1]} 可成交最优买卖价相对预言机偏离 ${match[2]}，超出 ${match[3]} 区间${match[4] ? `；另有 ${match[4]} 个触发` : ""}。`;
  match = text.match(/^Compare Futu (\d+) cash with its Binance perpetual, see an anchor-based fair-price scenario, and size a (\d+) \/ FX hedge\.$/);
  if (match) return `比较富途 ${match[1]} 现货与其 Binance 永续，查看基于所选基准的合理价格情景，并计算 ${match[2]} 及汇率对冲数量。`;
  match = text.match(/^Updated (\d+)s ago$/);
  if (match) return `${match[1]} 秒前更新`;
  return null;
}

export function translateInterfaceText(text: string): string {
  // Most market-data mutations are prices/codes: exit before normalization/cache.
  if (!/[A-Za-z]{2}/.test(text) || /^\s*(?:https?:\/\/|wss?:\/\/)/.test(text)) return text;
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const trimmed = text.trim(), exact = dictionary.get(normalize(trimmed));
  if (!exact && (/^[A-Z\d:_./-]+$/.test(trimmed) || /^\s*(?:[A-Z]{1,8}\s*)?[-+−–—$¥₩€\d.,%/\s:()×≈<>]+(?:\s*[A-Z]{1,8})?\s*$/.test(text))) return text;
  const dynamic = exact ? null : translateDynamicText(trimmed);
  const translated = exact || dynamic ? text.replace(trimmed, exact ?? dynamic!) : translatePhrases(text);
  // Bounded, including dynamic labels; no unbounded cache of live quote strings.
  if (cache.size >= TRANSLATION_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(text, translated);
  return translated;
}
