/** T4: the original three-column Mist detail; every action targets an exact saved version. */
import React from 'react';
import {developmentCharged,developmentDomain,developmentInitiator,developmentInitiatorLabel,validFabricSample} from '../../../../server/src/shared/mistDevelopmentDomain';
import { apiService } from '../../../../services/apiService';
import { Archive, ArrowRight, Building2, CircleCheck, ClipboardList, Clock, Download, Ellipsis, FileCheck, FileText, History, Layers, PackageCheck, Paperclip, Pencil, Plus, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import { Avatar, BackLink, Banner, Button, Card, CardFooter, CardHeader, Checkbox, ChoiceCards, Dialog, EmptyState, Field, FormGrid, IconButton, IdentityHeader, KeyValue, MeasurementTable, MistPage, Mono, ObjectStage, Pill, RelatedList, Select, Stepper, SummaryNumbers, TextArea, TextInput, TextLink, Thumb, Timeline, UploadZone, useToast, type StepState } from '../../../../components/mist';
import type { MistConfirmation, MistDev, MistQc, MistRound, MistVersion } from '../../../../server/src/shared/mistWorkspace';
import { IMG, STAGES } from '../data';
import { useMistWorkspace } from '../runtime/workspace';
import { useNav } from '../nav';
import { developmentFactoryOptions, InlineDevelopmentFactoryDialog } from './DevCreatePage';
import { devVersions, developmentRoundBlocker, minorParent, minorVersionBlocker, minorVersions } from '../../../../server/src/shared/mistDevelopmentRounds';
import { DevNoticeCard } from './DevNotices';
import { DevRoundsCard, NewRoundDialog, RoundRequirementsDialog, versionQcFlag, type NewRoundInput } from './DevRounds';
import { ToProductDialog, developmentVersionLinks, productConversionBlocker } from './DevVersionLinks';
import { DevSampleFormsCard } from './DevSampleForms';
import { DEVELOPMENT_BILLING_LOCK } from '../../../../server/src/shared/mistDevelopmentBilling';
import { DevBillingCard } from './DevBilling';
import { confirmationNeedsForms, developmentVersionSamples, sampleRef } from '../../../../server/src/shared/mistDevelopmentSamples';

export function localConfirmationTime(date=new Date()){return Number.isNaN(date.getTime())?'':new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16);}
export function confirmationFormError(values:{confirmer:string;organization:string;confirmedAt:string;basis:string;originalText:string}){
  if(!values.confirmer.trim())return '请填写实际确认人';
  if(!values.confirmedAt||Number.isNaN(new Date(values.confirmedAt).getTime()))return '请填写有效的确认时间';
  if(!values.basis.trim())return '请填写确认依据';return null;
}
export function developmentStepStates(dev:MistDev,version:MistVersion|undefined):StepState[]{
  const confirmation=version?.confirmations.at(-1);
  return [dev.values.name&&(developmentDomain(dev.values)==='fabric'||dev.values.style)?'done':'now',version?.returnedAt?'done':version?'now':'todo',version?.qc?(version.qc.result==='reject'?'blocked':'done'):version?.returnedAt?'now':'todo',confirmation?(confirmation.result==='approved'?'done':'blocked'):version?.returnedAt?'now':'todo',version?.archivedAt?'done':confirmation?.result==='approved'&&version?.qc&&version.qc.result!=='reject'?'now':'todo'];
}
const resultLabel={approved:'认可',needs_adjustment:'需修改',rejected:'不采用'};
const qcLabel={pass:'通过',conditional:'有保留通过',reject:'不通过'};
type Form={confirmer:string;organization:string;confirmedAt:string;basis:string;originalText:string;result:MistConfirmation['result']};
const emptyForm=(organization='',confirmer=''):Form=>({confirmer,organization,confirmedAt:localConfirmationTime(),basis:'',originalText:'',result:'approved'});
type MeasurementDraft={key:string;point:string;standard:string;actual:string;tolerance:string};
type FabricFactDraft={key:string;property:string;actual:string;unit:string};
type QcForm=Omit<MistQc,'measurements'|'appearanceDefects'|'fabricMeasurements'> & {measurements:MeasurementDraft[];fabricMeasurements:FabricFactDraft[];appearanceDefects:string};
export function fabricQcFacts(rows:FabricFactDraft[]):NonNullable<MistQc['fabricMeasurements']>{return rows.map((row,index)=>{if(!row.property.trim()||!row.unit.trim()||!row.actual.trim()||!Number.isFinite(Number(row.actual))||Number(row.actual)<0)throw Error(`请完整填写面料实测 ${index+1} 的项目、有限非负数和单位`);return{property:row.property.trim(),actual:Number(row.actual),unit:row.unit.trim()};});}
const newMeasurement=():MeasurementDraft=>({key:crypto.randomUUID(),point:'',standard:'',actual:'',tolerance:''});
const qcForm=(value:MistQc|null|undefined,reviewer=''):QcForm=>({result:value?.result||'pass',reviewer:value?.reviewer||reviewer,reviewedAt:value?localConfirmationTime(new Date(value.reviewedAt)):localConfirmationTime(),report:value?.report||'',opinion:value?.opinion||'',measurements:(value?.measurements||[]).map(row=>({...row,key:crypto.randomUUID(),standard:String(row.standard),actual:String(row.actual),tolerance:String(row.tolerance)})),fabricMeasurements:(value?.fabricMeasurements||[]).map(row=>({...row,key:crypto.randomUUID(),actual:String(row.actual)})),appearanceDefects:value?.appearanceDefects===undefined?'':String(value.appearanceDefects)});
export function qcMeasurementFacts(form:QcForm):Pick<MistQc,'measurements'|'appearanceDefects'>{
  if(form.measurements.length>200)throw Error('测量记录最多支持200行');
  const measurements=form.measurements.map((row,index)=>{
    const values=[row.standard,row.actual,row.tolerance];
    if(!row.point.trim()||values.some(value=>!value.trim()||!Number.isFinite(Number(value))||Number(value)<0))throw Error(`请完整填写第 ${index+1} 个测量点，数值须为有限非负数`);
    return{point:row.point.trim(),standard:Number(row.standard),actual:Number(row.actual),tolerance:Number(row.tolerance)};
  });
  if(form.appearanceDefects.trim()&&(!Number.isSafeInteger(Number(form.appearanceDefects))||Number(form.appearanceDefects)<0))throw Error('外观缺陷数量须为非负整数');
  return{measurements,...(form.appearanceDefects.trim()?{appearanceDefects:Number(form.appearanceDefects)}:{})};
}

export function DevDetailPage(){
  const {go,route}=useNav();const {state,loading,error,run,uploadFile,downloadFile,fileUrl,pending,recover,saving}=useMistWorkspace();const toast=useToast();
  const dev=state?.devs.find(item=>item.id===route.id),versions=state&&dev?devVersions(state,dev):[]; // 按开发案版本顺序，小版本紧跟所属大版本
  const fabricDomain=!!dev&&developmentDomain(dev.values)==='fabric';
  const [versionId,setVersionId]=React.useState(route.versionId||''),[form,setForm]=React.useState<Form>(()=>emptyForm()),[dialog,setDialog]=React.useState<'confirm'|'actions'|'revise'|'minor'|'archive'|'sample'|'qc'|'edit'|'round'|'qcDecide'|'close'|'product'|null>(null),[busy,setBusy]=React.useState(false),[failure,setFailure]=React.useState('');
  const [note,setNote]=React.useState(''),[sample,setSample]=React.useState({sample:'',quantity:'1',form:'',unit:'',location:'',color:'',returnedAt:localConfirmationTime()}),[qc,setQc]=React.useState<QcForm>(()=>qcForm(null)),[edit,setEdit]=React.useState({goal:'',due:'',factories:''}),[factoryDialog,setFactoryDialog]=React.useState(false),[roundInitial,setRoundInitial]=React.useState<Partial<NewRoundInput>|undefined>(),[decision,setDecision]=React.useState<{kind:'rework'|'abandon';note:string}>({kind:'rework',note:''}),[closure,setClosure]=React.useState<{kind:'archived'|'cancelled';reason:string}>({kind:'cancelled',reason:''});
  const version=versions.find(item=>item.id===(versionId||dev?.currentVersionId)),scope=React.useRef('');scope.current=`${dev?.id||''}:${version?.id||''}`;
  const fabricRequirements=version?.fabricRequirements||dev?.values.fabricRequirements;
  const reportUploadScope=React.useRef<string|null>(null);
  const live=React.useRef(true),busyRef=React.useRef(false);React.useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  React.useEffect(()=>{setVersionId(route.versionId||dev?.currentVersionId||'');},[route.id,route.versionId,dev?.id]);
  React.useEffect(()=>{if(!version){setQc(qcForm(null,state?.settings.profileName||''));return;}const last=version.confirmationDraft||version.confirmations.at(-1);setForm(last?{confirmer:last.confirmer,organization:last.organization,confirmedAt:localConfirmationTime(new Date(last.confirmedAt)),basis:last.basis,originalText:last.originalText,result:last.result}:dev&&developmentInitiator(dev.values)==='internal'?emptyForm('内部需求方',dev.values.requester||''):emptyForm(dev?.customer));setSample({sample:version.sample==='—'?'':version.sample,quantity:String(version.sampleQuantity||1),form:version.sampleForm||dev?.values.sampleForm||'',unit:version.sampleUnit||dev?.values.sampleUnit||'',location:version.sampleLocation||'',color:version.sampleColor||dev?.values.color||'',returnedAt:localConfirmationTime()});setQc(qcForm(version.qc,state?.settings.profileName||''));setFailure('');},[version?.id]);
  const [confirmSampleIds,setConfirmSampleIds]=React.useState<string[]>([]);React.useEffect(()=>{const saved=version?.confirmationDraft||version?.confirmations.at(-1);setConfirmSampleIds(saved?.samples?.map(sample=>sample.sampleId)||[]);},[version?.id]);
  const versionSamples=state&&version?developmentVersionSamples(state,version):[],needsForms=!!(state&&dev&&version&&confirmationNeedsForms(state,dev,version));
  const set=<K extends keyof Form>(key:K,value:Form[K])=>setForm(previous=>({...previous,[key]:value}));
  const chooseVersion=(id:string)=>{if(busy||!dev)return;setVersionId(id);setDialog(null);go('development/detail',dev.id,{versionId:id,...(route.customerId?{customerId:route.customerId}:{})});};
  const finish=(message:string)=>{setDialog(null);setFailure('');toast(message);};
  const act=async(kind:'confirm'|'draft'|'revise'|'minor'|'archive'|'sample'|'qc'|'edit'|'qcDecide'|'close')=>{
    if(!dev||busyRef.current||(!version&&kind!=='edit'&&kind!=='close'))return;const originalScope=scope.current;busyRef.current=true;setBusy(true);setFailure('');
    try{
      if(kind==='draft'){await run({type:'development.saveConfirmationDraft',payload:{devId:dev.id,versionId:version!.id,draft:{...form,...(confirmSampleIds.length?{samples:versionSamples.filter(sample=>confirmSampleIds.includes(sample.id)).map(sampleRef)}:{}),confirmedAt:form.confirmedAt&&!Number.isNaN(new Date(form.confirmedAt).getTime())?new Date(form.confirmedAt).toISOString():''}}});}
      else if(kind==='confirm'){
        const invalid=confirmationFormError(form);if(invalid)throw Error(invalid);
        if(needsForms&&!confirmSampleIds.length)throw Error('本版有多种实物形态，请选择本次确认针对的形态');
        await run({type:'development.confirm',payload:{devId:dev.id,versionId:version!.id,...form,confirmedAt:new Date(form.confirmedAt).toISOString(),...(confirmSampleIds.length?{sampleIds:confirmSampleIds}:{})}});
      }else if(kind==='revise'){
        if(!note.trim())throw Error('请填写本次修改要求');
        const receipt=await run({type:'development.revise',payload:{devId:dev.id,versionId:version!.id,note}});
        if(live.current&&scope.current===originalScope&&receipt.result.versionId){setVersionId(receipt.result.versionId);go('development/detail',dev.id,{versionId:receipt.result.versionId,...(route.customerId?{customerId:route.customerId}:{})});}
      }else if(kind==='minor'){
        if(!note.trim())throw Error('请写明本次调整了什么');
        const receipt=await run({type:'development.version.recordMinor',payload:{devId:dev.id,versionId:version!.id,change:note}});
        if(live.current&&scope.current===originalScope&&receipt.result.versionId){setVersionId(receipt.result.versionId);go('development/detail',dev.id,{versionId:receipt.result.versionId,...(route.customerId?{customerId:route.customerId}:{})});}
      }else if(kind==='archive')await run({type:'development.archive',payload:{devId:dev.id,versionId:version!.id}});
      else if(kind==='sample'){
        if(!sample.sample.trim()||(fabricDomain?!validFabricSample(Number(sample.quantity),sample.form,sample.unit):!/^[1-9]\d*$/.test(sample.quantity))||Number.isNaN(new Date(sample.returnedAt).getTime()))throw Error(fabricDomain?'请填写准确实物编号、形态、数量、单位和返样时间；米样按米，剪片按整数份':'请填写实物编号、正整数数量和有效返样时间');
        await run({type:'development.recordSample',payload:{devId:dev.id,versionId:version!.id,sample:sample.sample,quantity:Number(sample.quantity),returnedAt:new Date(sample.returnedAt).toISOString(),...(fabricDomain?{form:sample.form,unit:sample.unit,location:sample.location,color:sample.color}:{})}});
      }else if(kind==='qc'){
        if(!qc.reviewer.trim()||!qc.report.trim()||Number.isNaN(new Date(qc.reviewedAt).getTime()))throw Error('请填写评审人、报告和有效评审时间');
        const facts=fabricDomain?{measurements:[],fabricMeasurements:fabricQcFacts(qc.fabricMeasurements)}:qcMeasurementFacts(qc);
        await run({type:'development.recordQc',payload:{devId:dev.id,versionId:version!.id,...(fabricDomain?{domain:'fabric' as const}:{}),qc:{result:qc.result,reviewer:qc.reviewer,report:qc.report,opinion:qc.opinion,reviewedAt:new Date(qc.reviewedAt).toISOString(),...facts}}});
      }else if(kind==='close'){
        if(!closure.reason.trim())throw Error('请填写原因');
        await run({type:'development.close',payload:{devId:dev.id,kind:closure.kind,reason:closure.reason}});
      }else if(kind==='qcDecide'){
        if(decision.kind==='abandon'&&!decision.note.trim())throw Error('请填写放弃原因');
        await run({type:'development.qc.decide',payload:{devId:dev.id,versionId:version!.id,decision:decision.kind,note:decision.note}});
      }else await run({type:'development.update',payload:{devId:dev.id,patch:{goal:edit.goal,due:edit.due,factories:edit.factories.split(/[、,，\n]/).map(value=>value.trim()).filter(Boolean)}}});
      if(live.current&&(kind==='revise'||kind==='minor'||scope.current===originalScope))finish(({draft:'本版确认草稿已保存',confirm:'已保存本版需求方确认',revise:'新版本已建立，原版记录已保留',minor:'小版本已生成，沿用大版本实物与 QC；需求方确认请对小版本单独记录',archive:'已保存本版成果留档',sample:'已保存本版返样实物',qc:'已保存本版 QC 报告',edit:'开发计划已更新',close:closure.kind==='cancelled'?'开发案已取消':'开发案已归档',qcDecide:decision.kind==='rework'?'已转为整改复检，原 QC 记录已保留':'本版已标记不采用，其他版本不受影响'})[kind]);
    }catch(cause){if(live.current&&scope.current===originalScope)setFailure(cause instanceof Error?cause.message:'操作失败，原内容已保留');}finally{busyRef.current=false;if(live.current)setBusy(false);}
  };
  const uploadReport=async(files:File[])=>{if(busyRef.current||pending)return;if(files.length!==1){setFailure('每次请选择一份 QC 报告');return;}const originalScope=scope.current;reportUploadScope.current=originalScope;busyRef.current=true;setBusy(true);try{const file=await uploadFile(files[0]);if(live.current&&scope.current===originalScope)setQc(previous=>({...previous,report:file.id}));reportUploadScope.current=null;}catch(cause){if(live.current&&scope.current===originalScope)setFailure(String(cause));}finally{busyRef.current=false;if(live.current)setBusy(false);}};
  const mediaFile=(version?.fileIds||[]).map(id=>state?.files.find(file=>file.id===id)).find(file=>file?.mimeType.startsWith('image/'));
  const mediaUrl=mediaFile?fileUrl(mediaFile):'', [picture,setPicture]=React.useState<string>(),[pictureError,setPictureError]=React.useState(false),[pictureRetry,setPictureRetry]=React.useState(0);
  React.useEffect(()=>{let active=true,objectUrl='';const controller=new AbortController();setPicture(undefined);setPictureError(false);if(mediaUrl)void fetch(mediaUrl,{headers:apiService.getAuthHeaders(),credentials:'include',signal:controller.signal}).then(response=>{if(!response.ok)throw Error('图片读取失败');return response.blob();}).then(blob=>{if(active){objectUrl=URL.createObjectURL(blob);setPicture(objectUrl);}}).catch(()=>{if(active)setPictureError(true);});return()=>{active=false;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};},[mediaUrl,pictureRetry]);
  const recoverWrite=async()=>{
    if(!pending||busyRef.current)return;
    const original=pending,originalScope=scope.current;busyRef.current=true;setBusy(true);
    try{
      const receipt=await recover();if(!receipt||!live.current)return;
      let feedback='';
      if(original.kind==='upload'){
        const id=receipt.result.fileId||receipt.result.id;
        if(id&&reportUploadScope.current===originalScope&&scope.current===originalScope)setQc(previous=>({...previous,report:id}));
        else if(id)feedback=`已恢复附件 ${id}；未自动关联当前版本，请核对后填写报告附件。`;
        reportUploadScope.current=null;
      }else if(scope.current===originalScope){
        setDialog(null);
        if(original.command?.type==='development.revise'&&receipt.result.devId&&receipt.result.versionId){setVersionId(receipt.result.versionId);go('development/detail',receipt.result.devId,{versionId:receipt.result.versionId,...(route.customerId?{customerId:route.customerId}:{})});}
        toast('原操作已核对并更新');
      }
      setFailure(feedback);
    }catch(cause){if(live.current&&scope.current===originalScope)setFailure(String(cause));}finally{busyRef.current=false;if(live.current)setBusy(false);}
  };
  const toProduct=async(input:{sku:string;supplierCode:string})=>{
    if(!dev||!version||busyRef.current)return;busyRef.current=true;setBusy(true);setFailure('');
    try{const supplier=state?.market.suppliers.find(item=>item.name===version.factory);
      await run({type:'market.product.fromVersion',payload:{devId:dev.id,versionId:version.id,sku:input.sku,...(supplier?{supplierId:supplier.id}:{}),...(input.supplierCode?{supplierCode:input.supplierCode}:{})}});
      if(live.current)finish(`已从 ${version.label} 建立产品档案 ${input.sku}`);}
    catch(cause){if(live.current)setFailure(cause instanceof Error?cause.message:'档案尚未建立，原内容已保留');}finally{busyRef.current=false;if(live.current)setBusy(false);}
  };
  const createRound=async(input:NewRoundInput)=>{
    if(!dev||busyRef.current)return;busyRef.current=true;setBusy(true);setFailure('');
    try{const receipt=await run({type:'development.round.create',payload:{devId:dev.id,...input}});setRoundInitial(undefined);const id=receipt.result.versionId;
      if(live.current){setDialog(null);toast('新一轮已建立，之前各轮记录保持不变');if(id){setVersionId(id);go('development/detail',dev.id,{versionId:id,...(route.customerId?{customerId:route.customerId}:{})});}}}
    catch(cause){if(live.current)setFailure(cause instanceof Error?cause.message:'本轮尚未建立，原内容已保留');}finally{busyRef.current=false;if(live.current)setBusy(false);}
  };
  const [roundEdit,setRoundEdit]=React.useState<MistRound|null>(null);
  const saveRoundRequirements=async(requirements:string)=>{
    if(!dev||!roundEdit||busyRef.current)return;busyRef.current=true;setBusy(true);setFailure('');
    try{await run({type:'development.round.updateRequirements',payload:{devId:dev.id,roundId:roundEdit.id,requirements}});if(live.current){setRoundEdit(null);toast('共同要求已修改；各工厂任务需逐厂同步后才更新');}}
    catch(cause){if(live.current)setFailure(cause instanceof Error?cause.message:'共同要求尚未保存，原内容已保留');}finally{busyRef.current=false;if(live.current)setBusy(false);}
  };
  const syncRoundTask=async(target:MistVersion)=>{
    if(!dev||busyRef.current)return;busyRef.current=true;setBusy(true);setFailure('');
    try{await run({type:'development.version.syncRequirements',payload:{devId:dev.id,versionId:target.id}});if(live.current)toast(`${target.label} 已同步共同要求`);}
    catch(cause){if(live.current)toast(cause instanceof Error?cause.message:`${target.label} 尚未同步`);}finally{busyRef.current=false;if(live.current)setBusy(false);}
  };
  const generateNotice=async()=>{
    if(!dev||!version||busyRef.current)return;busyRef.current=true;setBusy(true);setFailure('');
    try{await run({type:'development.notice.generate',payload:{devId:dev.id,versionId:version.id}});if(live.current)toast(`${version.label} 通知单已生成，旧版保留`);}
    catch(cause){if(live.current)toast(cause instanceof Error?cause.message:'通知单尚未生成');}finally{busyRef.current=false;if(live.current)setBusy(false);}
  };
  const noticeFile=(fileId:string)=>state?.files.find(file=>file.id===fileId);
  const downloadNotice=(fileId:string)=>{const file=noticeFile(fileId);if(!file){toast('通知单文件不可用或无权读取');return;}void downloadFile(file).catch(cause=>toast(cause instanceof Error?cause.message:'通知单下载失败'));};
  /** 打印：取归档原件，在新窗口用浏览器 PDF 预览打开后打印；不重新生成。 */
  const printNotice=(fileId:string)=>{
    const file=noticeFile(fileId);if(!file){toast('通知单文件不可用或无权读取');return;}
    const win=window.open('','_blank');
    void (async()=>{const response=await fetch(fileUrl(file),{headers:apiService.getAuthHeaders(),credentials:'include'});if(!response.ok){win?.close();throw new Error('通知单文件读取失败');}
      const url=URL.createObjectURL(new Blob([await response.arrayBuffer()],{type:'application/pdf'}));if(win)win.location.href=url;else window.open(url,'_blank');window.setTimeout(()=>URL.revokeObjectURL(url),60000);})().catch(cause=>toast(cause instanceof Error?cause.message:'通知单打印失败'));
  };
  const uploadRoundFiles=async(files:File[])=>{
    if(busyRef.current)return [];busyRef.current=true;setBusy(true);setFailure('');const ids:string[]=[];
    try{for(const file of files){if(file.size>50*1024*1024)throw Error(`${file.name} 超过 50MB`);ids.push((await uploadFile(file)).id);}}
    catch(cause){if(live.current)setFailure(cause instanceof Error?cause.message:'附件上传失败');}finally{busyRef.current=false;if(live.current)setBusy(false);}
    return ids;
  };
  const backToSource=()=>route.customerId?go('crm',route.customerId,{customerId:route.customerId}):go('development');
  const editFactories=edit.factories.split(/[、,，\n]/).map(value=>value.trim()).filter(Boolean);
  const factoryOptions=developmentFactoryOptions(state,editFactories,dev?developmentDomain(dev.values):'garment');
  const recovery=pending?<Button loading={busy||saving} onClick={()=>void recoverWrite()}>核对原操作结果</Button>:null;
  if(!dev)return <MistPage><BackLink onClick={backToSource}>{route.customerId?'返回客户档案':'开发与寻样'}</BackLink><Card><EmptyState icon={Layers} title={loading?'正在读取开发案':'未找到开发案'} description={error||'请从开发列表选择一个已保存的开发案。'} /></Card></MistPage>;
  const currentImage=version?.img||dev.img,files=(version?.fileIds||dev.fileIds).map(id=>state?.files.find(file=>file.id===id)).filter(file=>!!file),last=version?.confirmations.at(-1),steps=developmentStepStates(dev,version),history=(state?.events||[]).filter(event=>event.entityId===dev.id||event.entityId===version?.id).slice().sort((a,b)=>b.at.localeCompare(a.at));
  const openEdit=()=>{setEdit({goal:dev.goal,due:dev.due,factories:dev.values.factories.join('、')});setDialog('edit');};
  const currentFormError=confirmationFormError(form)||(needsForms&&!confirmSampleIds.length?'请选择本次确认针对的形态':null);
  const sameForms=JSON.stringify([...(last?.samples||[]).map(sample=>sample.sampleId)].sort())===JSON.stringify([...confirmSampleIds].sort());
  const sameConfirmation=last&&sameForms&&last.result===form.result&&last.confirmer===form.confirmer&&last.organization===form.organization&&last.basis===form.basis&&last.originalText===form.originalText&&new Date(last.confirmedAt).getTime()===new Date(form.confirmedAt).getTime();
  const measurements=version?.qc?.measurements||[],measureStats=measurements.reduce((counts,row)=>{const difference=Math.abs(row.actual-row.standard),epsilon=row.tolerance===0?0:Number.EPSILON*Math.max(1,row.actual,row.standard,row.tolerance)*4;return{within:counts.within+(difference<=row.tolerance+epsilon?1:0),attention:counts.attention+(difference>row.tolerance*.5+epsilon?1:0)};},{within:0,attention:0});
  const links=developmentVersionLinks(state,version),productBlocker=productConversionBlocker(version);
  const qcFailed=version?.qc?.result==='reject'&&!version.qcDecision,qcAllowsConfirm=!!version?.qc&&version.qc.result!=='reject'&&!version.qcDecision;
  const resampleRound=version?.qcDecision?.roundId?state?.rounds?.find(round=>round.id===version.qcDecision!.roundId):undefined;
  const roundBlocker=developmentRoundBlocker(state!,dev);
  const parentVersion=version&&state?minorParent(state,version):undefined,childMinors=version&&state?minorVersions(state,version):[],minorBlocker=version&&state?minorVersionBlocker(state,dev,version):'请先选择版本';
  const sampleBlocker=version?.minor?`小版本沿用 ${parentVersion?.label||'大版本'} 实物，不登记新实物`:dev.billing?.request?DEVELOPMENT_BILLING_LOCK:undefined,qcBlocker=version?.minor?`小版本沿用 ${parentVersion?.label||'大版本'} QC 结论`:childMinors.length?`已有小版本 ${childMinors.map(item=>item.label).join('、')} 沿用本版 QC 结论，不能改写`:undefined;
  const openResample=()=>{if(!version?.qc)return;setFailure('');setRoundInitial({factories:[version.factory],referenceVersionIds:[version.id],requirements:`QC 意见（${version.label}）：${version.qc.opinion||'见 QC 报告'}`,targetDate:dev.due||'',fileIds:[],resampleFromVersionId:version.id});setDialog('round');};
  const openDecision=(kind:'rework'|'abandon')=>{setDecision({kind,note:''});setFailure('');setDialog('qcDecide');};
  const qcGate=!version?null:version.qcDecision?.kind==='abandon'?<Banner tone="bad" title="本版已放弃 · 不采用">{version.qcDecision.note||'未填写原因'}；其他版本不受影响。</Banner>
    :version.qcDecision?.kind==='resample'?<Banner tone="neutral" title="本版 QC 不通过 · 已重新打样">{resampleRound?`已开第 ${resampleRound.number} 轮，请在新版本上记录 QC 与确认。`:'已开新一轮。'}</Banner>
    :qcFailed?<><Banner tone="bad" title="QC 不通过 · 不能记录确认">{version.qc!.opinion||'请查看 QC 报告'}</Banner><div className="mist-row" role="group" aria-label="QC 不通过处理" style={{flexWrap:'wrap',gap:8,marginTop:10}}>{!fabricDomain&&<Button size="sm" disabled={busy} onClick={()=>openDecision('rework')}>整改复检</Button>}<Button size="sm" disabled={busy||!!roundBlocker} title={roundBlocker||undefined} onClick={openResample}>重新打样</Button><Button size="sm" variant="quiet" disabled={busy} onClick={()=>openDecision('abandon')}>放弃本版</Button>{roundBlocker&&<span className="mist-note">{roundBlocker}</span>}</div></>
    :version.qc?.result==='conditional'?<Banner tone="warn" title="需关注 · QC 有保留通过">{version.qc.opinion||'请查看 QC 报告'}</Banner>
    :!version.qc?<Banner tone="neutral" title={version.qcHistory?.length?'整改中 · 待复检':'QC 待评审'}>QC 通过或有保留通过后才能记录需求方确认。</Banner>:null;
  const qcReviewedAt=version?.qc?localConfirmationTime(new Date(version.qc.reviewedAt)):'';
  const openQc=()=>{setQc(qcForm(version?.qc,state?.settings.profileName||''));setFailure('');setDialog('qc');};
  const setMeasurement=(key:string,patch:Partial<MeasurementDraft>)=>setQc(previous=>({...previous,measurements:previous.measurements.map(row=>row.key===key?{...row,...patch}:row)}));
  return <MistPage>
    <BackLink onClick={backToSource}>{route.customerId?'返回客户档案':'开发与寻样'}</BackLink>
    <IdentityHeader thumb={<Thumb src={fabricDomain?picture:picture||IMG[currentImage]} icon={fabricDomain?Layers:undefined} size="lg" />} meta={[developmentInitiator(dev.values)==='internal'?developmentInitiatorLabel(dev.values):dev.customer,<Mono key="code">{dev.code}</Mono>,<Mono key="style">{dev.style}</Mono>]} title={dev.name} facts={[{label:'负责人',value:<><Avatar name={dev.owner} size="xs" />{dev.owner}</>},{label:'目标日期',value:dev.due},{label:'发起方',value:developmentInitiatorLabel(dev.values)},{label:'费用',value:developmentCharged(dev.values)?'收费':'不收费'},{label:'状态',value:<Pill tone={dev.tone}>{dev.state}</Pill>}]} actions={<IconButton icon={Ellipsis} label="更多" onClick={()=>setDialog('actions')} />} />
    <Stepper steps={STAGES.map((label,index)=>({label,state:steps[index]}))} onSelect={index=>document.getElementById(['mist-dev-goal','mist-dev-sample','mist-dev-qc','mist-dev-confirmation','mist-dev-archive'][index])?.scrollIntoView({behavior:'smooth',block:'start'})} />
    {(failure||error)&&<div className="mist-section"><Banner tone="bad" title="操作未完成">{failure||error}</Banner></div>}
    {pending&&!saving&&<div className="mist-section"><Banner tone="warn" title="原操作结果尚待核对" actions={recovery}>已保留原请求，核对前请勿重复提交。</Banner></div>}
    <div className="mist-detail">
      <div>
        <Card clip>
          {(mediaFile&&!picture)||fabricDomain&&!picture?<div className="mist-stage" data-size="lg"><EmptyState icon={Layers} title={!mediaFile?'尚未上传本版实物图片':pictureError?'图片读取失败':'正在读取图片'} description={mediaFile?.name||'返样事实与图片分别保存，不用示例图冒充实物。'} action={pictureError?<TextLink onClick={()=>setPictureRetry(value=>value+1)}>重试</TextLink>:undefined} /></div>:<ObjectStage size="lg" src={picture||IMG[currentImage]} alt={dev.name} caption={version?`${version.returnedAt?'返样实物':'计划版本'} · ${version.label}`:'开发计划'} />}
          <div className="mist-vers" role="group" aria-label="版本">{versions.map(item=><button key={item.id} type="button" aria-pressed={version?.id===item.id} disabled={busy} onClick={()=>chooseVersion(item.id)}>{item.label}{(flag=>flag&&<> <Pill tone={flag.tone}>{flag.label}</Pill></>)(versionQcFlag(item))}</button>)}</div>
          <KeyValue items={[{label:'工厂',value:version?.factory||'待安排'},{label:'样品',value:version?`${version.sample||'未登记'} · ${version.sampleQuantity} ${fabricDomain?version.sampleUnit||dev.values.sampleUnit||'单位待登记':(!version.returnedAt&&version.task?.sampleUnit)||'件'}`:'未建立版本'},...(fabricDomain?[{label:'实物形态',value:version?.sampleForm||dev.values.sampleForm||'待登记'}]:[{label:'尺码',value:version?.size||dev.values.sizeBase}]),{label:'面料',value:version?.fabric||dev.fabric}]} />
          <CardFooter><span className="mist-note">准确版本独立记录</span><span className="mist-spacer" /><Button size="sm" disabled={!version||busy||!!sampleBlocker} title={sampleBlocker} icon={PackageCheck} onClick={()=>setDialog('sample')}>登记返样</Button></CardFooter>
          {version?.minor&&<div className="mist-section" data-minor={version.label}><Banner tone="neutral" title={`小版本 · 沿用 ${parentVersion?.label||'大版本'} 实物与 QC 结论`}>本次调整：{version.minor.change}。需求方确认须对 {version.label} 单独记录，不继承 {parentVersion?.label||'大版本'} 的确认。</Banner></div>}
          {!!childMinors.length&&<p className="mist-note" style={{padding:'0 22px 12px'}}>本版小调整：{childMinors.map(item=>`${item.label}（${item.minor!.change}）`).join('；')}</p>}
        </Card>
        {state&&<DevRoundsCard state={state} dev={dev} versionId={version?.id} busy={busy} onSelect={chooseVersion} onCreate={()=>{setFailure('');setRoundInitial(undefined);setDialog('round');}} onEditRequirements={round=>{setFailure('');setRoundEdit(round);}} onSync={target=>void syncRoundTask(target)}/>}
        {state&&version&&<DevSampleFormsCard state={state} dev={dev} version={version} disabled={busy||!!pending} run={run}/>}
        {state&&<div data-dev-billing><DevBillingCard state={state} dev={dev} disabled={busy||!!pending} run={run}/></div>}
        {state&&version&&!version.minor&&<DevNoticeCard state={state} dev={dev} version={version} busy={busy} onGenerate={()=>void generateNotice()} onDownload={downloadNotice} onPrint={printNotice}/>}
        {fabricDomain&&<Card><CardHeader title="面料开发目标规格" sub="目标要求，不代表工厂分析或 QC 实测"/><KeyValue items={[{label:'分类',value:dev.values.category||'待核实'},{label:'本版工厂要求',value:version?.note||'待记录'},{label:'目标成分',value:fabricRequirements?.composition||'待工厂分析'},{label:'克重原值',value:`${fabricRequirements?.weightValue||'待分析'} ${fabricRequirements?.weightUnit||''}`},{label:'幅宽原值',value:`${fabricRequirements?.widthValue||'待分析'} ${fabricRequirements?.widthUnit||''}`},{label:'纱支 / 组织',value:`${fabricRequirements?.yarn||'待分析'} / ${fabricRequirements?.weave||'待分析'}`},{label:'用途 / 手感',value:`${fabricRequirements?.usage||'—'} / ${fabricRequirements?.handle||'—'}`},{label:'后整理 / 性能',value:`${fabricRequirements?.finish||'—'} / ${fabricRequirements?.performance||'—'}`}]}/></Card>}
        <Card id="mist-dev-goal"><CardHeader title="开发目标" /><p className="mist-sub" style={{padding:'10px 22px 20px',fontSize:13.5}}>{dev.goal||'尚未填写开发目标'}</p></Card>
        <Card id="mist-dev-sample"><CardHeader title="版本附件" />{files.length?files.map(file=><div className="mist-row" key={file!.id} style={{padding:'10px 22px'}}><FileText className="mist-icon" /><span>{file!.name}</span><span className="mist-spacer" /><TextLink icon={Download} onClick={()=>void downloadFile(file!).catch(cause=>setFailure(String(cause)))}>下载</TextLink></div>):<EmptyState compact title="本版暂无附件" />}</Card>
      </div>
      <div>
        <Card clip id="mist-dev-confirmation">
          <div className="mist-action-top"><span className="mist-eyebrow">04 · 需求方确认</span><h2 className="mist-h1">确认这一版。</h2><div className="mist-action-src"><b style={{fontWeight:500,color:'var(--mist-ink)'}}>{version?.factory||'待安排工厂'} · {version?.label||'未建立版本'}</b><span className="mist-sep" /><Pill tone={version?.qc?.result==='reject'?'bad':version?.qc?.result==='conditional'?'warn':version?.qc?'ok':'neutral'}>{version?.qc?`QC ${qcLabel[version.qc.result]}`:'QC 待评审'}</Pill>{version?.qc?.result==='conditional'&&<Pill tone="warn">需关注</Pill>}</div></div>
          {qcGate&&<div style={{padding:'4px 24px 8px'}}>{qcGate}</div>}
          <div style={{padding:'4px 24px 0'}}><ChoiceCards ariaLabel="确认结论" value={form.result} onChange={value=>set('result',value)} options={[{value:'approved',title:'认可',description:'记录本版认可结果',icon:CircleCheck},{value:'needs_adjustment',title:'需修改',description:'保留意见，再发起新一版',icon:Pencil},{value:'rejected',title:'不采用',description:'保留原因记录',icon:X}]} /></div>
          <div style={{padding:'18px 24px 6px'}}><FormGrid>
            <Field label="实际确认人" required error={!form.confirmer.trim()?'请填写确认人':undefined}><TextInput icon={Users} value={form.confirmer} onChange={event=>set('confirmer',event.target.value)} placeholder="客户或需求方联系人" /></Field>
            <Field label="所属组织"><TextInput icon={Building2} value={form.organization} onChange={event=>set('organization',event.target.value)} /></Field>
            <Field label="确认时间" required><TextInput icon={Clock} type="datetime-local" value={form.confirmedAt} onChange={event=>set('confirmedAt',event.target.value)} /></Field>
            <Field label="确认依据" required hint="填写实际沟通来源与凭证说明"><TextInput icon={Paperclip} value={form.basis} onChange={event=>set('basis',event.target.value)} /></Field>
            {needsForms&&<div className="mist-field" data-full="true" role="group" aria-label="确认针对的形态"><span className="mist-field-label">确认针对的形态 <span className="mist-muted">（必选）</span></span>{versionSamples.map(item=><Checkbox key={item.id} checked={confirmSampleIds.includes(item.id)} label={`${item.form} · ${item.code} · ${item.quantity} ${item.unit}`} onChange={checked=>setConfirmSampleIds(previous=>checked?[...previous.filter(id=>id!==item.id),item.id]:previous.filter(id=>id!==item.id))} />)}</div>}
            <Field label="需求方原文" full><TextArea value={form.originalText} onChange={event=>set('originalText',event.target.value)} placeholder="记录认可意见、修改要求或不采用原因" /></Field>
          </FormGrid></div>
          <CardFooter><span className="mist-note"><ShieldCheck className="mist-icon" data-size="xs" />{state?.settings.profileName}登记 · 对应本版实物与报告</span><span className="mist-spacer" /><Button variant="quiet" disabled={!version||busy} onClick={()=>void act('draft')}>存为草稿</Button><Button variant="primary" iconRight={ArrowRight} disabled={!version||busy||!qcAllowsConfirm||!!currentFormError||!!sameConfirmation} onClick={()=>setDialog('confirm')}>{sameConfirmation?'本版已记录':'保存确认'}</Button></CardFooter>
        </Card>
        <Card id="mist-dev-qc"><CardHeader title="QC 评审" tools={<><span className="mist-muted" style={{fontSize:12.5}}>{version?.qc?`${version.qc.reviewer} · ${qcReviewedAt.slice(5,10).replace('-','/')} ${qcReviewedAt.slice(11)}`:'待评审'}</span><Button size="sm" disabled={!version||busy||qcFailed||!!version?.qcDecision||!!version?.confirmations.length||!!qcBlocker} title={qcBlocker} onClick={openQc}>{version?.qc?'更新报告':version?.qcHistory?.length?'提交复检':'录入报告'}</Button></>}>{version?.qc&&<Pill tone={version.qc.result==='reject'?'bad':version.qc.result==='conditional'?'warn':'ok'}>{qcLabel[version.qc.result]}</Pill>}</CardHeader>
          {!fabricDomain&&<><SummaryNumbers items={[{label:'测量点',value:measurements.length},{label:'公差内',value:measureStats.within},{label:'需关注',value:measureStats.attention,tone:'warn'},{label:'外观缺陷',value:version?.qc?.appearanceDefects??'—'}]} />
          <MeasurementTable rows={measurements} /></>}
          {fabricDomain&&<KeyValue items={(version?.qc?.fabricMeasurements||[]).map(row=>({label:row.property,value:`${row.actual} ${row.unit}`}))}/>}
          {fabricDomain&&!version?.qc?.fabricMeasurements?.length&&<p className="mist-note">未记录面料实测；专业结论独立填写，不套成衣公差。</p>}
          {version?.qc?<><KeyValue items={[{label:'报告',value:state?.files.find(file=>file.id===version.qc!.report)?.name||version.qc.report},{label:'评审意见',value:version.qc.opinion||'未记录'}]} />{state?.files.find(file=>file.id===version.qc!.report)&&<CardFooter><TextLink icon={Download} onClick={()=>void downloadFile(state.files.find(file=>file.id===version.qc!.report)!).catch(cause=>setFailure(String(cause)))}>下载本版报告</TextLink></CardFooter>}</>:<CardFooter><span className="mist-note">本版尚未录入 QC 报告，结论由评审人独立填写。</span></CardFooter>}
          {!!version?.qcHistory?.length&&<div className="mist-section"><CardHeader title="历次 QC" sub="整改复检前的结论全部保留" /><Timeline events={version.qcHistory.slice().reverse().map(item=>({who:item.reviewer,when:new Date(item.reviewedAt).toLocaleString(),text:`${qcLabel[item.result]} · ${item.report}\n${item.opinion||'未记录意见'}${item.decision?`\n处理：${item.decision.kind==='rework'?'整改复检':item.decision.kind==='abandon'?'放弃本版':'重新打样'}${item.decision.note?` · ${item.decision.note}`:''}`:''}`}))} /></div>}
        </Card>
      </div>
      <div className="mist-detail-rail">
        <Card><CardHeader title="动态" tools={<IconButton icon={History} label="定位动态记录" size="sm" onClick={()=>document.getElementById('mist-dev-history')?.scrollIntoView({behavior:'smooth'})} />} /><div id="mist-dev-history">{history.length?<Timeline events={history.map(event=>({who:event.actor,when:new Date(event.at).toLocaleString(),text:event.text}))} />:<EmptyState compact title="暂无业务动态" />}</div></Card>
        <Card><CardHeader title="确认记录" />{version?.confirmations.length?<Timeline events={version.confirmations.slice().reverse().map(item=>({who:item.confirmer,when:new Date(item.confirmedAt).toLocaleString(),text:`${resultLabel[item.result]} · ${item.organization}${item.samples?.length?`\n针对形态：${item.samples.map(ref=>`${ref.form} ${ref.code}`).join('、')}`:''}\n${item.basis}${item.originalText?`\n${item.originalText}`:''}`}))} />:<EmptyState compact title="本版暂无确认记录" />}</Card>
        <Card id="mist-dev-archive"><CardHeader title="关联" /><RelatedList items={[
            ...(links.product?[{icon:Archive,title:links.product.sku,sub:`产品档案 · ${links.product.name}`,onClick:()=>go('products',links.product!.id)}]:[]),
            ...links.samples.map(sample=>({icon:PackageCheck,title:sample.code,sub:`本版实物样品 · ${sample.name}`,onClick:()=>go('samples',sample.id)})),
            ...links.qcTasks.map(task=>({icon:ShieldCheck,title:task.code,sub:`QC 任务 · ${task.factory}`,onClick:()=>go('qc-workbench',task.id,{section:task.kind})})),
            ...links.quotations.map(quote=>({icon:FileText,title:quote.code,sub:'引用本版的报价',onClick:()=>go('quotations',quote.id)})),
            ...links.orders.map(order=>({icon:ClipboardList,title:order.code,sub:'引用本版的订单',onClick:()=>go('orders/detail',order.id)})),
            ...(dev.customerId?[{icon:Users,title:dev.customer,sub:'客户档案',onClick:()=>go('crm',dev.customerId,{customerId:dev.customerId})}]:[])]} />
          {links.product?<div className="mist-row" style={{padding:'6px 22px 10px',gap:8}}><span className="mist-note">本版产品档案</span><TextLink onClick={()=>go('products',links.product!.id)}><Mono>{links.product.sku}</Mono></TextLink></div>
            :<div className="mist-row" style={{padding:'6px 22px 10px',gap:8,flexWrap:'wrap'}}><Button size="sm" icon={Archive} disabled={!version||busy||!!productBlocker} title={productBlocker||undefined} onClick={()=>{setFailure('');setDialog('product');}}>转为产品档案</Button>{productBlocker&&<span className="mist-note">{productBlocker}</span>}</div>}<CardFooter><span className="mist-note">{version?.archivedAt?`本版已留档 · ${new Date(version.archivedAt).toLocaleDateString()}`:'本版尚未留档'}</span><Button size="sm" disabled={!version||busy||!!version.archivedAt} onClick={()=>setDialog('archive')}>成果留档</Button></CardFooter></Card>
      </div>
    </div>
    <Dialog open={dialog==='confirm'} onClose={()=>!busy&&setDialog(null)} icon={form.result==='rejected'?X:CircleCheck} tone={form.result==='rejected'?'bad':form.result==='needs_adjustment'?'warn':'ok'} title={`记录 ${version?.label||''}：${resultLabel[form.result]}？`} description="本次决定只记录在当前准确版本；原有报告和历史记录继续保留。" footer={<>{recovery}<Button variant="quiet" disabled={busy} onClick={()=>setDialog(null)}>取消</Button><Button variant={form.result==='rejected'?'danger':'primary'} loading={busy} onClick={()=>void act('confirm')}>确认提交</Button></>}><KeyValue items={[{label:'实际确认人',value:form.confirmer},{label:'组织',value:form.organization},{label:'确认依据',value:form.basis}]} /></Dialog>
    <Dialog open={dialog==='actions'} onClose={()=>setDialog(null)} title="开发版本操作"><div className="mist-col"><Button disabled={!version||!!roundBlocker} title={roundBlocker||undefined} onClick={()=>{setNote('');setDialog('revise');}}>基于本版发起修改</Button>{!fabricDomain&&<><Button disabled={!!minorBlocker} title={minorBlocker||undefined} onClick={()=>{setNote('');setFailure('');setDialog('minor');}}>记录小调整</Button>{minorBlocker&&<p className="mist-note">{minorBlocker}</p>}</>}<Button disabled={!version||!!version.archivedAt} onClick={()=>setDialog('archive')}>成果留档</Button><Button disabled={!!roundBlocker} title={roundBlocker||undefined} onClick={()=>{setFailure('');setDialog('round');}}>开新一轮</Button><Button onClick={openEdit}>编辑开发计划</Button>{roundBlocker&&<p className="mist-note">{roundBlocker}</p>}{!dev.closure&&<><Button variant="quiet" onClick={()=>{setClosure({kind:'cancelled',reason:''});setFailure('');setDialog('close');}}>取消开发案</Button><Button variant="quiet" onClick={()=>{setClosure({kind:'archived',reason:''});setFailure('');setDialog('close');}}>归档开发案</Button></>}</div></Dialog>
    <Dialog open={dialog==='close'} onClose={()=>!busy&&setDialog(null)} icon={X} tone="warn" title={closure.kind==='cancelled'?'取消开发案':'归档开发案'} description="结束后不能再开新一轮、改版或重新打样；已有版本记录保留。" footer={<><Button variant="quiet" disabled={busy} onClick={()=>setDialog(null)}>返回</Button><Button variant="primary" loading={busy} disabled={!closure.reason.trim()} onClick={()=>void act('close')}>{closure.kind==='cancelled'?'确认取消':'确认归档'}</Button></>}>
      {failure&&<Banner tone="bad" title="尚未保存">{failure}</Banner>}
      <Field label="原因" required full><TextArea value={closure.reason} onChange={event=>setClosure(previous=>({...previous,reason:event.target.value}))} /></Field>
    </Dialog>
    <Dialog open={dialog==='qcDecide'} onClose={()=>!busy&&setDialog(null)} icon={decision.kind==='rework'?Pencil:X} tone={decision.kind==='rework'?'warn':'bad'} title={decision.kind==='rework'?`整改复检 ${version?.label||''}`:`放弃 ${version?.label||''}`} description={decision.kind==='rework'?'工厂在同一版本上整改，再提交 QC；本次不通过记录会保留。':'本版标记为不采用，其他版本不受影响。'} footer={<><Button variant="quiet" disabled={busy} onClick={()=>setDialog(null)}>取消</Button><Button variant="primary" loading={busy} disabled={decision.kind==='abandon'&&!decision.note.trim()} onClick={()=>void act('qcDecide')}>{decision.kind==='rework'?'确认整改复检':'确认放弃本版'}</Button></>}>
      {failure&&<Banner tone="bad" title="尚未保存">{failure}</Banner>}
      <Field label={decision.kind==='rework'?'整改要求':'放弃原因'} required={decision.kind==='abandon'} full><TextArea value={decision.note} onChange={event=>setDecision(previous=>({...previous,note:event.target.value}))} placeholder={decision.kind==='rework'?'例如：袖长按 QC 意见改短 1cm':'例如：工厂工艺无法达到要求'} /></Field>
    </Dialog>
    <ToProductDialog open={dialog==='product'} version={version} busy={busy} failure={failure} onClose={()=>setDialog(null)} onSubmit={input=>void toProduct(input)} />
    <RoundRequirementsDialog round={roundEdit} busy={busy} failure={roundEdit?failure:''} onClose={()=>setRoundEdit(null)} onSubmit={value=>void saveRoundRequirements(value)}/>
    {state&&<NewRoundDialog open={dialog==='round'} initial={roundInitial} state={state} dev={dev} busy={busy} failure={failure} factoryOptions={developmentFactoryOptions(state,dev.values.factories,fabricDomain?'fabric':'garment')} onClose={()=>{setDialog(null);setRoundInitial(undefined);}} onAddFactory={()=>setFactoryDialog(true)} onSubmit={input=>void createRound(input)} onUpload={uploadRoundFiles}/>}
    <Dialog open={dialog==='revise'} onClose={()=>!busy&&setDialog(null)} title={`基于 ${version?.label||''} 发起新一版`} description="原版与其确认、报告继续保留。" footer={<>{recovery}<Button variant="quiet" onClick={()=>setDialog(null)}>取消</Button><Button variant="primary" loading={busy} disabled={!note.trim()} onClick={()=>void act('revise')}>建立新版本</Button></>}><Field label="本次修改要求" required><TextArea value={note} onChange={event=>setNote(event.target.value)} /></Field></Dialog>
    <Dialog open={dialog==='minor'} onClose={()=>!busy&&setDialog(null)} title={`在 ${version?.label||''} 上记录小调整`} description={`生成 ${version?`${version.label}.${childMinors.length+1}`:''}：沿用 ${version?.label||''} 实物与 QC 结论，不登记新实物、不新建封样；需求方确认须对小版本单独记录。`} footer={<>{recovery}<Button variant="quiet" onClick={()=>setDialog(null)}>取消</Button><Button variant="primary" loading={busy} disabled={!note.trim()} onClick={()=>void act('minor')}>生成小版本</Button></>}>{failure&&dialog==='minor'&&<Banner tone="bad" title="未生成">{failure}</Banner>}<Field label="改了什么" required><TextArea value={note} onChange={event=>setNote(event.target.value)} placeholder="例如：领口改小 0.5cm" /></Field></Dialog>
    <Dialog open={dialog==='archive'} onClose={()=>!busy&&setDialog(null)} title={`将 ${version?.label||''} 留档？`} description="按当前版本记录保存成果，保留所依据的实物、报告和需求方决定。" footer={<>{recovery}<Button variant="quiet" onClick={()=>setDialog(null)}>取消</Button><Button variant="primary" loading={busy} onClick={()=>void act('archive')}>确认留档</Button></>} />
    <Dialog open={dialog==='sample'} onClose={()=>!busy&&setDialog(null)} title={`登记 ${version?.label||''} 返样实物`} footer={<>{recovery}<Button variant="quiet" onClick={()=>setDialog(null)}>取消</Button><Button variant="primary" loading={busy} onClick={()=>void act('sample')}>保存返样</Button></>}>{failure&&<Banner tone="bad" title="返样尚未保存">{failure}</Banner>}<FormGrid><Field label="实物编号" required><TextInput value={sample.sample} onChange={event=>setSample(previous=>({...previous,sample:event.target.value}))} /></Field><Field label={fabricDomain?"数量 / 长度":"数量"} required><TextInput type="number" min={fabricDomain?"0.0001":"1"} step={fabricDomain?"any":"1"} value={sample.quantity} onChange={event=>setSample(previous=>({...previous,quantity:event.target.value}))} /></Field>{fabricDomain&&<><Field label="实际样品形态" required><TextInput value={sample.form} onChange={e=>setSample(v=>({...v,form:e.target.value,unit:e.target.value.trim()==='米样'?'米':'份'}))}/></Field><Field label="实际单位" required><TextInput readOnly value={sample.unit}/></Field><Field label="实际位置"><TextInput value={sample.location} onChange={e=>setSample(v=>({...v,location:e.target.value}))}/></Field><Field label="实际颜色"><TextInput value={sample.color} onChange={e=>setSample(v=>({...v,color:e.target.value}))}/></Field></>}<Field label="返样时间" required full><TextInput type="datetime-local" value={sample.returnedAt} onChange={event=>setSample(previous=>({...previous,returnedAt:event.target.value}))} /></Field></FormGrid></Dialog>
    <Dialog open={dialog==='qc'} onClose={()=>!busy&&setDialog(null)} width={860} title={`录入 ${version?.label||''} QC 报告`} footer={<>{recovery}<Button variant="quiet" disabled={busy} onClick={()=>setDialog(null)}>取消</Button><Button variant="primary" loading={busy} disabled={!!pending} onClick={()=>void act('qc')}>保存报告</Button></>}>
      {failure&&<Banner tone="bad" title="报告尚未保存">{failure}</Banner>}
      <FormGrid><Field label="总体结论" required hint={fabricDomain?"由评审人独立填写，不由实测数值自动判定":"由评审人独立填写，不由尺寸或公差自动判定"}><Select disabled={busy} value={qc.result} onChange={event=>setQc(previous=>({...previous,result:event.target.value as MistQc['result']}))} options={[{value:'pass',label:'通过'},{value:'conditional',label:'有保留通过'},{value:'reject',label:'不通过'}]} /></Field><Field label="评审人" required><TextInput disabled={busy} value={qc.reviewer} onChange={event=>setQc(previous=>({...previous,reviewer:event.target.value}))} /></Field><Field label="评审时间" required><TextInput disabled={busy} type="datetime-local" value={qc.reviewedAt} onChange={event=>setQc(previous=>({...previous,reviewedAt:event.target.value}))} /></Field><Field label="报告编号或附件" required><TextInput disabled={busy} value={qc.report} onChange={event=>setQc(previous=>({...previous,report:event.target.value}))} /></Field><Field label="评审意见" full><TextArea disabled={busy} value={qc.opinion} onChange={event=>setQc(previous=>({...previous,opinion:event.target.value}))} /></Field><Field label="外观缺陷数量" hint="未记录请留空，已检查且无缺陷请填 0"><TextInput disabled={busy} type="number" min="0" step="1" value={qc.appearanceDefects} onChange={event=>setQc(previous=>({...previous,appearanceDefects:event.target.value}))} /></Field></FormGrid>
      {!fabricDomain&&<div className="mist-section"><CardHeader title="尺寸测量" sub="单位 cm；记录本版实物的标准、实测和允许公差。" />{qc.measurements.map((row,index)=><div key={row.key} className="mist-section"><div className="mist-row"><span className="mist-h2">测量点 {index+1}</span><span className="mist-spacer" /><IconButton icon={Trash2} label={`删除测量点 ${index+1}`} disabled={busy} onClick={()=>setQc(previous=>({...previous,measurements:previous.measurements.filter(item=>item.key!==row.key)}))} /></div><FormGrid><Field label={`部位 ${index+1}`} required full><TextInput disabled={busy} value={row.point} onChange={event=>setMeasurement(row.key,{point:event.target.value})} /></Field><Field label={`标准 ${index+1}（cm）`} required><TextInput disabled={busy} type="number" min="0" step="any" value={row.standard} onChange={event=>setMeasurement(row.key,{standard:event.target.value})} /></Field><Field label={`实测 ${index+1}（cm）`} required><TextInput disabled={busy} type="number" min="0" step="any" value={row.actual} onChange={event=>setMeasurement(row.key,{actual:event.target.value})} /></Field><Field label={`公差 ${index+1}（±cm）`} required><TextInput disabled={busy} type="number" min="0" step="any" value={row.tolerance} onChange={event=>setMeasurement(row.key,{tolerance:event.target.value})} /></Field></FormGrid></div>)}<Button icon={Plus} disabled={busy||qc.measurements.length>=200} onClick={()=>setQc(previous=>({...previous,measurements:[...previous.measurements,newMeasurement()]}))}>添加测量点</Button></div>}
      {fabricDomain&&<div className="mist-section"><CardHeader title="面料实测" sub="记录本版真实数值和原单位；不自动判断合格，不改写开发目标。"/>{qc.fabricMeasurements.map((row,index)=><div key={row.key} className="mist-section"><FormGrid><Field label={`实测项目 ${index+1}`}><TextInput value={row.property} onChange={e=>setQc(v=>({...v,fabricMeasurements:v.fabricMeasurements.map(r=>r.key===row.key?{...r,property:e.target.value}:r)}))}/></Field><Field label={`实测值 ${index+1}`}><TextInput inputMode="decimal" value={row.actual} onChange={e=>setQc(v=>({...v,fabricMeasurements:v.fabricMeasurements.map(r=>r.key===row.key?{...r,actual:e.target.value}:r)}))}/></Field><Field label={`原单位 ${index+1}`}><TextInput value={row.unit} onChange={e=>setQc(v=>({...v,fabricMeasurements:v.fabricMeasurements.map(r=>r.key===row.key?{...r,unit:e.target.value}:r)}))}/></Field><Button variant="quiet" onClick={()=>setQc(v=>({...v,fabricMeasurements:v.fabricMeasurements.filter(r=>r.key!==row.key)}))}>移除此项</Button></FormGrid></div>)}<Button className="mist-section" icon={Plus} disabled={busy||qc.fabricMeasurements.length>=200} onClick={()=>setQc(v=>({...v,fabricMeasurements:[...v.fabricMeasurements,{key:crypto.randomUUID(),property:'',actual:'',unit:''}]}))}>添加面料实测</Button></div>}
      <UploadZone hint="可选择一份 QC 报告文件" onFiles={files=>void uploadReport(files)} />
    </Dialog>
    <InlineDevelopmentFactoryDialog open={factoryDialog} domain={fabricDomain?'fabric':'garment'} onClose={()=>setFactoryDialog(false)} onCreated={name=>setEdit(previous=>({...previous,factories:[...new Set([...editFactories,name])].join('、')}))}/>
    <Dialog open={dialog==='edit'} onClose={()=>!busy&&setDialog(null)} title="编辑开发计划" footer={<>{recovery}<Button variant="quiet" onClick={()=>setDialog(null)}>取消</Button><Button variant="primary" loading={busy} onClick={()=>void act('edit')}>保存计划</Button></>}><FormGrid><Field label="目标日期"><TextInput type="date" value={edit.due} onChange={event=>setEdit(previous=>({...previous,due:event.target.value}))} /></Field><div className="mist-field" data-full="true" role="group" aria-label="参与工厂"><span className="mist-field-label">参与工厂</span>{factoryOptions.map(factory=><Checkbox key={factory.name} checked={editFactories.includes(factory.name)} disabled={factory.unavailable&&!editFactories.includes(factory.name)} label={factory.name+(factory.unavailable?' · 已停用':factory.historical?' · 历史工厂':'')} onChange={checked=>setEdit(previous=>({...previous,factories:(checked?[...editFactories,factory.name]:editFactories.filter(name=>name!==factory.name)).join('、')}))}/>)}{!factoryOptions.length&&<p className="mist-note">尚无实际工厂，请先添加。</p>}<Button onClick={()=>setFactoryDialog(true)}>新增工厂</Button></div><Field label="开发目标" full><TextArea value={edit.goal} onChange={event=>setEdit(previous=>({...previous,goal:event.target.value}))} /></Field></FormGrid></Dialog>
  </MistPage>;
}
