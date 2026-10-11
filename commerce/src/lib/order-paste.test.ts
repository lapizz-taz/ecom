import { describe, expect, it } from 'vitest'
import { findPhones, parseOrderText } from './order-paste'

describe('pasting an order', () => {
  it('reads labelled English text', () => {
    expect(parseOrderText('Name: Rahim Uddin\nPhone: 01712-345678\nAddress: House 12, Road 5, Dhanmondi, Dhaka\nProduct: Canvas Tote x2')).toEqual({
      name: 'Rahim Uddin', phone: '01712345678', address: 'House 12, Road 5, Dhanmondi, Dhaka', district: 'Dhaka', area: 'Dhanmondi',
    })
  })

  it('reads plain lines without labels', () => {
    expect(parseOrderText('Nusrat Jahan\n+880 1812 345 678\nMirpur 10, Dhaka')).toMatchObject({
      name: 'Nusrat Jahan', phone: '01812345678', address: 'Mirpur 10, Dhaka', district: 'Dhaka', area: 'Mirpur 10',
    })
  })

  it('reads Bangla labels and Bangla digits', () => {
    expect(parseOrderText('নাম: করিম\nমোবাইল: ০১৯১২৩৪৫৬৭৮\nঠিকানা: গ্রাম- চরপাড়া, সদর, কুমিল্লা')).toMatchObject({
      name: 'করিম', phone: '01912345678', district: 'Cumilla',
    })
  })

  it('reads one comma-separated line', () => {
    expect(parseOrderText('sabbir ahmed, 01612345678, agrabad, chittagong')).toMatchObject({
      name: 'Sabbir Ahmed', phone: '01612345678', district: 'Chattogram', area: 'Agrabad',
    })
  })

  it('finds the district from a known area and keeps a second number as a note', () => {
    expect(parseOrderText('Tania\n01711111111 / 01822222222\nSector 7, Uttara')).toMatchObject({
      name: 'Tania', phone: '01711111111', altPhone: '01822222222', district: 'Dhaka', note: 'Alt phone 01822222222',
    })
  })

  it('only picks districts the store delivers to', () => {
    expect(parseOrderText('Road 2, Sylhet', ['Dhaka']).district).toBeUndefined()
  })

  it('accepts inline labels on one line and an e-mail', () => {
    expect(parseOrderText('Name - Jamal | Mobile - 8801555666777 | Email: jamal@example.com | District: Bogra | Thana: Sherpur')).toMatchObject({
      name: 'Jamal', phone: '01555666777', email: 'jamal@example.com', district: 'Bogura', area: 'Sherpur',
    })
  })

  it('ignores numbers that are not mobile phones', () => {
    expect(findPhones('Order 12345678901, call 01987654321')).toEqual(['01987654321'])
  })
})
