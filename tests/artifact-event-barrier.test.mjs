import test from 'node:test';
import assert from 'node:assert/strict';
import {qualificationReady,validateQualificationBarrier} from './runtime/artifact-event-barrier.ts';
const key='a'.repeat(64),other='b'.repeat(64),head='c'.repeat(40);
const event=(event_key=key)=>({event_key,status:'complete',event:{after:head}});
test('a foreign delivery cannot satisfy a duplicate event barrier',()=>{
 const value={events:[event(),event(other)],deliveries:[{message_id:'first',event_key:key},{message_id:'foreign',event_key:other}]};
 const input={eventKey:key,previousDeliveryIds:['first']};validateQualificationBarrier(input);
 assert.equal(qualificationReady(value,input),false);
 value.deliveries.push({message_id:'duplicate',event_key:key});assert.equal(qualificationReady(value,input),true);
});
test('a native push requires a new complete event and its own delivery after the baseline',()=>{
 const value={events:[event()],deliveries:[{message_id:'first',event_key:key}]};
 const input={after:head,previousEventKeys:[key],previousDeliveryIds:['first']};validateQualificationBarrier(input);
 value.deliveries.push({message_id:'old-event-duplicate',event_key:key});assert.equal(qualificationReady(value,input),false);
 value.events.push({...event(other),status:'pending'});value.deliveries.push({message_id:'native',event_key:other});assert.equal(qualificationReady(value,input),false);
 value.events[1].status='complete';assert.equal(qualificationReady(value,input),true);
});
