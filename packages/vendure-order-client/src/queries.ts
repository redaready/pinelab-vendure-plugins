import { GraphQLClient, gql } from 'graphql-request';

export class GraphqlQueries {
  constructor(private ADDITIONAL_ORDER_FIELDS: string) {
    // if (additionalOrderFields) {
    //   this.ADDITIONAL_ORDER_FIELDS = additionalOrderFields;
    // }
  }

  ACTIVE_ORDER_FIELDS = gql`
    ${this.ADDITIONAL_ORDER_FIELDS}
    fragment ActiveOrderFields on Order {
      ...AdditionalOrderFields
      id
      code
      state
      active
      totalWithTax
      subTotalWithTax
      shippingWithTax
      totalQuantity
      customer {
        id
        firstName
        lastName
        phoneNumber
        emailAddress
      }
      shippingAddress {
        fullName
        company
        streetLine1
        streetLine2
        city
        postalCode
        country
      }
      billingAddress {
        fullName
        company
        streetLine1
        streetLine2
        city
        postalCode
        country
      }
      shippingLines {
        shippingMethod {
          id
          code
          name
        }
        priceWithTax
      }
      lines {
        id
        quantity
        linePriceWithTax
        featuredAsset {
          id
          preview
        }
        productVariant {
          id
          sku
          name
          priceWithTax
        }
      }
      taxSummary {
        taxRate
        taxTotal
        taxBase
      }
      payments {
        id
        state
        errorMessage
        metadata
      }
      discounts {
        description
        amountWithTax
      }
      couponCodes
    }
  `;

  ADD_ITEM_TO_ORDER = gql`
    ${this.ACTIVE_ORDER_FIELDS}
    mutation additemToOrder($productVariantId: ID!, $quantity: Int!) {
      addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
        ... on Order {
          ...ActiveOrderFields
        }
        ... on ErrorResult {
          errorCode
          message
        }
      }
    }
  `;

  ADJUST_ORDERLINE = gql`
    ${this.ACTIVE_ORDER_FIELDS}
    mutation adjustOrderLine($orderLineId: ID!, $quantity: Int!) {
      adjustOrderLine(orderLineId: $orderLineId, quantity: $quantity) {
        ... on Order {
          ...ActiveOrderFields
        }
        ... on ErrorResult {
          errorCode
          message
        }
      }
    }
  `;

  REMOVE_ALL_ORDERLINES = gql`
    ${this.ACTIVE_ORDER_FIELDS}
    mutation removeAllOrderLines {
      removeAllOrderLines {
        ... on Order {
          ...ActiveOrderFields
        }
        ... on ErrorResult {
          errorCode
          message
        }
      }
    }
  `;

  GET_ACTIVE_ORDER = gql`
    ${this.ACTIVE_ORDER_FIELDS}
    query activeOrder {
      activeOrder {
        ...ActiveOrderFields
      }
    }
  `;
}
