import assert from 'node:assert/strict'
import { verifyPropertyIdentity } from '../src/services/property-api/property-identity'

const property = { id: 'fixture-id', address: '123 North Main Court Apt 2', city: 'Hartford', state: 'CT', zipCode: '06103-1234' }
for (const address of [
  '123 N Main Ct Unit 2, Hartford, CT 06103',
  '123 North Main Court #2 Hartford Connecticut 06103-9876',
  '123 N Main Ct Apt 2, Hartford, CT',
  '123 N Main Ct #2 06103',
]) assert(verifyPropertyIdentity({ address }, property).matched, address)
for (const address of [
  '124 N Main Ct Unit 2, Hartford, CT 06103',
  '123 S Main Ct Unit 2, Hartford, CT 06103',
  '123 N Main Ct Unit 3, Hartford, CT 06103',
  '123 N Main Ct, Hartford, CT 06103',
  '123 N Main Ct Unit 2, New Haven, CT 06103',
  '123 N Main Ct Unit 2, Hartford, NY 06103',
  '123 N Main Ct Unit 2, Hartford, CT 06104',
  '123 N Main Ct Unit 2',
]) assert(!verifyPropertyIdentity({ address }, property).matched, address)
assert(verifyPropertyIdentity({ streetAddress: '123 N Main Ct #2', zipCode: '06103' }, property).matched)
assert(verifyPropertyIdentity({ streetAddress: '123 N Main Ct #2', city: 'Hartford', state: 'Connecticut' }, property).matched)
assert(!verifyPropertyIdentity({ streetAddress: '123 N Main Ct #2', city: 'Hartford' }, property).matched)
assert(!verifyPropertyIdentity({ streetAddress: '123 N Main Ct #2', zipCode: '06103', city: 'New Haven' }, property).matched)
assert(!verifyPropertyIdentity({ streetAddress: '123 N Main Ct #2', zipCode: '06103', state: 'NY' }, property).matched)
assert(!verifyPropertyIdentity({ streetAddress: '123 N Main Ct #2', zipCode: 'invalid' }, property).matched)
assert(!verifyPropertyIdentity({ address: '123 N Main Ct #2 06103' }, property, 'another-id').matched)
assert(verifyPropertyIdentity({ address: '123 N Main Ct #2 06103' }, property, property.id).matched)
assert(!verifyPropertyIdentity({ address: '123 N Main Ct #2 06103' }, { ...property, id: '' }).matched)
assert(!verifyPropertyIdentity({}, property).matched)
assert(verifyPropertyIdentity({}, property, property.id).matched)
assert(!verifyPropertyIdentity({}, property, 'another-id').matched)
assert(!verifyPropertyIdentity({}, { ...property, address: '' }, property.id).matched)
const multiword = { id: 'nc', address: '25 Lake Shore Drive', city: 'Chapel Hill', state: 'NC', zipCode: '27514' }
assert(verifyPropertyIdentity({ address: '25 Lake Shore Dr, Chapel Hill, North Carolina 27514' }, multiword).matched)
assert(!verifyPropertyIdentity({ address: '25 Lake Shore Dr, Chapel Hill, South Carolina 27514' }, multiword).matched)
const stLouis = { id: 'mo', address: '10 Park St', city: 'St Louis', state: 'MO', zipCode: '63101' }
assert(verifyPropertyIdentity({ address: '10 Park Street St. Louis Missouri 63101' }, stLouis).matched)
console.log('Property identity: exact street/unit/locality, ZIP, selected ID, Connecticut and multiword states passed')
