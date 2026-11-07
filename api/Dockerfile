FROM golang:1.26-alpine
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN go build -o /bin/api .
EXPOSE 4521
CMD ["/bin/api"]
