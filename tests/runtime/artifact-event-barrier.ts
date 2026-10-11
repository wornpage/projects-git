export interface QualificationBarrier {
  eventKey?:string;after?:string;minimumDeliveries?:number;
  previousEventKeys?:string[];previousDeliveryIds?:string[];
}
interface Readback {
  events:{event_key:string;status:string;event:{after:string}}[];
  deliveries:{message_id:string;event_key:string}[];
}
export function validateQualificationBarrier(input:QualificationBarrier):void {
  const keys=input.previousEventKeys??[],deliveries=input.previousDeliveryIds??[];
  if((!input.eventKey&&!input.after)||(input.eventKey&&!/^[a-f0-9]{64}$/.test(input.eventKey))
    ||(input.after&&!/^[a-f0-9]{40}$/.test(input.after))
    ||(input.minimumDeliveries!==undefined&&(!Number.isSafeInteger(input.minimumDeliveries)||input.minimumDeliveries<1||input.minimumDeliveries>4096))
    ||!Array.isArray(keys)||keys.length>4096||keys.some(k=>typeof k!=='string'||!/^[a-f0-9]{64}$/.test(k))
    ||!Array.isArray(deliveries)||deliveries.length>4096||deliveries.some(d=>typeof d!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(d)))throw Error('INVALID_QUALIFICATION_BARRIER');
}
/** A new delivery must belong to the matched event, not the whole ledger. */
export function qualificationReady(value:Readback,input:QualificationBarrier):boolean {
  return value.events.some(event=>event.status==='complete'
    &&(!input.eventKey||event.event_key===input.eventKey)&&(!input.after||event.event.after===input.after)
    &&!(input.previousEventKeys??[]).includes(event.event_key)
    &&value.deliveries.filter(delivery=>delivery.event_key===event.event_key
      &&!(input.previousDeliveryIds??[]).includes(delivery.message_id)).length>=(input.minimumDeliveries??1));
}
